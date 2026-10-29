// background.js — X 互关检测器
// 数据策略：
// 1) 优先复用 x.com 页面登录态，调用 X 内部列表接口（快、字段全）。
// 2) 接口失效时降级为页面滚动采集（慢，但页面能打开就能用）。
// 3) 取关必须由用户逐条或勾选后触发；先尝试接口，失败再在主页点按钮兜底。
// 4) X 工作页被用户误关时自动重开，扫描与批量取关继续。

// X 网页端公开常量（浏览器 DevTools 中即可查看，非个人凭据；X 的鉴权依赖 Cookie 而非此值）
const X_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const X_HOSTS = ['https://x.com/*', 'https://twitter.com/*'];

const DEFAULT_SETTINGS = {
  maxAccounts: 2500,
  mode: 'auto',              // auto | api | dom
  pageDelayMinMs: 650,
  pageDelayMaxMs: 1200,
  unfollowDelayMinMs: 900,
  unfollowDelayMaxMs: 1800,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.round(min + Math.random() * Math.max(0, max - min));
const normalizeHandle = (s) => String(s || '').replace(/^@/, '').trim();

let currentScan = null;
let currentWorkTabId = null;
let scanStopFlag = false;
let batchUnfollow = null;
let batchStopFlag = false;
let unfollowLock = Promise.resolve();
let workTabReopenPromise = null;

class StopError extends Error {
  constructor() { super('已停止'); this.name = 'StopError'; }
}

function assertNotStopped() {
  if (scanStopFlag) throw new StopError();
}

// ---------- 存储 ----------
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...(patch || {}) };
  await chrome.storage.local.set({ settings: next });
  return next;
}
async function loadStoredScan() {
  const { scan } = await chrome.storage.local.get('scan');
  return scan || null;
}
async function persistScan(scan) {
  currentScan = scan;
  await chrome.storage.local.set({ scan });
}
async function getUsableScan() {
  if (currentScan) return currentScan;
  currentScan = await loadStoredScan();
  return currentScan;
}

// 保留名单：按 handle 持久化，跨扫描生效。
async function getWhitelist() {
  const { whitelist } = await chrome.storage.local.get('whitelist');
  return Array.isArray(whitelist) ? whitelist.map((h) => normalizeHandle(h).toLowerCase()).filter(Boolean) : [];
}
async function setWhitelist(list) {
  const clean = [...new Set((list || []).map((h) => normalizeHandle(h).toLowerCase()).filter(Boolean))];
  await chrome.storage.local.set({ whitelist: clean });
  return clean;
}

function safeErr(e) {
  return e && e.message ? e.message : String(e || '未知错误');
}

// ---------- 登录态 / X 工作页 ----------
async function checkLogin() {
  const domains = ['https://x.com/', 'https://twitter.com/'];
  for (const url of domains) {
    try {
      const c = await chrome.cookies.get({ url, name: 'auth_token' });
      if (c && c.value) return true;
    } catch (e) {}
  }
  return false;
}
async function getCsrfToken() {
  const domains = ['https://x.com/', 'https://twitter.com/'];
  for (const url of domains) {
    try {
      const c = await chrome.cookies.get({ url, name: 'ct0' });
      if (c && c.value) return c.value;
    } catch (e) {}
  }
  return '';
}

function waitTabComplete(tabId, timeoutMs = 35000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (e) {}
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === 'complete') finish();
    }).catch(finish);
    setTimeout(finish, timeoutMs);
  });
}

async function sendTab(tabId, msg, retries = 12, intervalMs = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, msg);
      if (r) return r;
    } catch (e) {}
    await sleep(intervalMs);
  }
  return null;
}

async function tabExists(tabId) {
  if (!tabId) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!(tab && tab.id);
  } catch (e) {
    return false;
  }
}

async function openXTab(url, active = false) {
  const tab = await chrome.tabs.create({ url, active: !!active });
  currentWorkTabId = tab.id;
  await waitTabComplete(tab.id, 40000);
  await sleep(1200);
  return tab.id;
}

// 扫描/批量取关共用的工作页。用户手动关掉后，这里负责自动重开。
async function reopenWorkTab(reason) {
  if (workTabReopenPromise) return workTabReopenPromise;
  workTabReopenPromise = (async () => {
    const id = await openXTab('https://x.com/home', false);
    currentWorkTabId = id;
    if (currentScan && currentScan.status === 'running') {
      currentScan.phase = 'X 工作页被关闭，已自动重开，继续扫描…';
      const note = 'X 工作页曾被关闭，已自动重开';
      if (!Array.isArray(currentScan.warnings)) currentScan.warnings = [];
      if (!currentScan.warnings.includes(note)) currentScan.warnings.push(note);
      await persistScan(currentScan);
    }
    if (batchUnfollow && batchUnfollow.running) {
      batchUnfollow.note = '工作页曾被关闭，已自动重开';
      batchUnfollow.reopened = (batchUnfollow.reopened || 0) + 1;
    }
    return id;
  })().finally(() => { workTabReopenPromise = null; });
  return workTabReopenPromise;
}

async function ensureWorkTab(preferredTabId) {
  const candidates = [...new Set([preferredTabId, currentWorkTabId].filter(Boolean))];
  for (const id of candidates) {
    if (await tabExists(id)) {
      currentWorkTabId = id;
      return id;
    }
  }
  return await reopenWorkTab('missing');
}

async function navigateTab(tabId, url) {
  let id = await ensureWorkTab(tabId);
  try {
    await chrome.tabs.update(id, { url });
  } catch (e) {
    id = await reopenWorkTab('navigate-failed');
    await chrome.tabs.update(id, { url });
  }
  await waitTabComplete(id, 40000);
  await sleep(1500);
  return id;
}

async function closeTab(tabId) {
  if (!tabId) return;
  if (tabId === currentWorkTabId) currentWorkTabId = null;
  try { await chrome.tabs.remove(tabId); } catch (e) {}
}

async function xFetch(tabId, csrf, args, retried = false) {
  if (!csrf) return { ok: false, status: 0, msg: '未找到 ct0 Cookie，请确认已登录 x.com' };
  let effectiveTabId;
  try {
    effectiveTabId = await ensureWorkTab(tabId);
  } catch (e) {
    return { ok: false, status: 0, msg: '无法打开 X 工作页：' + safeErr(e) };
  }

  const r = await sendTab(effectiveTabId, {
    type: 'X_FETCH',
    args: {
      ...args,
      csrf,
      authorization: 'Bearer ' + X_BEARER,
    },
  }, 8, 500);

  if (!r && !retried) {
    try {
      const recovered = await navigateTab(null, 'https://x.com/home');
      return await xFetch(recovered, csrf, args, true);
    } catch (e) {}
  }
  if (!r) return { ok: false, status: 0, msg: 'X 工作页没有响应，已尝试自动恢复，请稍后重试' };
  return r;
}

function responseError(r) {
  if (!r) return '无响应';
  if (r.msg) return r.msg;
  const j = r.json;
  if (j && Array.isArray(j.errors) && j.errors.length) {
    return j.errors.map((e) => e.message || e.code || '接口错误').join('；');
  }
  if (j && j.error) return String(j.error);
  return 'HTTP ' + (r.status || 0);
}

// ---------- 账号信息 ----------
async function getSession(tabId, csrf) {
  const r = await xFetch(tabId, csrf, {
    path: '/i/api/1.1/account/verify_credentials.json?skip_status=true&include_entities=false&include_followed_by=1',
  });
  if (r && r.ok && r.json) {
    const j = r.json;
    const handle = normalizeHandle(j.screen_name || (j.legacy && j.legacy.screen_name));
    const userId = String(j.id_str || j.id || j.rest_id || '');
    if (handle) {
      return {
        ok: true,
        handle,
        userId,
        name: j.name || handle,
        avatar: j.profile_image_url_https || '',
        method: 'api',
      };
    }
  }

  // 接口不可用时，从页面 DOM 取账号名；后续仍可用 screen_name 调用列表接口。
  const p = await sendTab(tabId, { type: 'GET_PAGE_INFO' });
  if (p && p.handle) {
    return {
      ok: true,
      handle: normalizeHandle(p.handle),
      userId: '',
      name: p.handle,
      avatar: '',
      method: 'dom',
      warning: '账号接口不可用，已从页面读取账号名：' + responseError(r),
    };
  }
  return { ok: false, msg: '无法读取当前 X 账号，请确认 Chrome 已登录 x.com。' + (r ? '（' + responseError(r) + '）' : '') };
}

// ---------- REST 列表接口 ----------
function buildListPath(kind, session, cursor) {
  const q = new URLSearchParams();
  q.set('include_profile_interstitial_type', '1');
  q.set('include_blocking', '1');
  q.set('include_blocked_by', '1');
  q.set('include_followed_by', '1');
  q.set('include_want_retweets', '1');
  q.set('include_mute_edge', '1');
  q.set('include_can_dm', '1');
  q.set('include_can_media_tag', '1');
  q.set('skip_status', '1');
  q.set('count', '200');
  q.set('cursor', cursor || '-1');
  if (session.userId) q.set('user_id', session.userId);
  else q.set('screen_name', session.handle);
  return `/i/api/1.1/${kind}/list.json?` + q.toString();
}

function countOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(v) {
  if (v === true || v === false) return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return null;
}

function normalizeApiUser(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const legacy = raw.legacy || {};
  const core = raw.core || {};
  const id = String(raw.id_str || raw.id || raw.rest_id || '');
  const handle = normalizeHandle(raw.screen_name || core.screen_name || legacy.screen_name || raw.handle);
  if (!handle) return null;
  const followedByRaw = raw.followed_by !== undefined ? raw.followed_by : legacy.followed_by;
  const followingRaw = raw.following !== undefined ? raw.following : legacy.following;
  return {
    id,
    handle,
    name: raw.name || core.name || legacy.name || handle,
    avatar: raw.profile_image_url_https || (raw.avatar && (raw.avatar.image_url || raw.avatar.image_url_https)) || legacy.profile_image_url_https || '',
    followsYou: boolOrNull(followedByRaw),
    following: boolOrNull(followingRaw),
    followersCount: countOrNull(raw.followers_count !== undefined ? raw.followers_count : legacy.followers_count),
    followingCount: countOrNull(raw.friends_count !== undefined ? raw.friends_count : legacy.friends_count),
    tweetsCount: countOrNull(raw.statuses_count !== undefined ? raw.statuses_count : legacy.statuses_count),
    verified: boolOrNull(raw.verified !== undefined ? raw.verified : legacy.verified) === true,
    bio: String(raw.description !== undefined ? raw.description : (legacy.description || '')).slice(0, 220),
    createdAt: raw.created_at || legacy.created_at || '',
    protectedAccount: boolOrNull(raw.protected !== undefined ? raw.protected : legacy.protected) === true,
  };
}

async function requestListPage(tabId, csrf, kind, session, cursor, scan, label) {
  const path = buildListPath(kind, session, cursor);
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    assertNotStopped();
    const r = await xFetch(tabId, csrf, { path });
    if (r && r.ok && r.json) {
      const j = r.json;
      if (Array.isArray(j.errors) && j.errors.length && !Array.isArray(j.users)) {
        lastErr = responseError(r);
        break;
      }
      return r;
    }
    lastErr = responseError(r);

    if (r && r.status === 429) {
      const reset = Number(r.rateLimitReset || 0) * 1000;
      const wait = Math.max(6000, Math.min(30000, reset ? reset - Date.now() + 1500 : 12000));
      scan.phase = label + '：触发 X 限流，等待 ' + Math.ceil(wait / 1000) + ' 秒后重试…';
      await persistScan(scan);
      await sleep(wait);
      continue;
    }
    if (r && (r.status === 401 || r.status === 403)) break;
    await sleep(1200 + attempt * 1500);
  }
  throw new Error(label + '失败：' + lastErr);
}

async function collectListRest(tabId, csrf, kind, session, settings, scan, opts = {}) {
  const max = Math.max(20, Number(opts.max || settings.maxAccounts || 2500));
  const out = [];
  const seenIds = new Set();
  const seenHandles = new Set();
  const seenCursors = new Set();
  let cursor = '-1';
  let unknown = 0;
  let page = 0;
  const label = kind === 'friends' ? '读取关注列表' : '读取粉丝列表';

  try {
    for (; page < 2000; page++) {
      assertNotStopped();
      const r = await requestListPage(tabId, csrf, kind, session, cursor, scan, label);
      const j = r.json || {};
      const users = Array.isArray(j.users) ? j.users : [];
      for (const raw of users) {
        const u = normalizeApiUser(raw);
        if (!u) continue;
        if (session.handle && u.handle.toLowerCase() === session.handle.toLowerCase()) continue;
        const idKey = u.id || u.handle.toLowerCase();
        if (seenIds.has(idKey) || seenHandles.has(u.handle.toLowerCase())) continue;
        seenIds.add(idKey);
        seenHandles.add(u.handle.toLowerCase());
        if (u.followsYou === null) unknown++;
        out.push(u);
        if (out.length >= max) break;
      }

      scan.phase = label + '：已读取 ' + out.length + ' 人' + (page ? '（第 ' + (page + 1) + ' 页）' : '');
      scan.progress = { phase: scan.phase, count: out.length, page: page + 1 };
      await persistScan(scan);

      if (out.length >= max) break;
      const nextRaw = j.next_cursor_str !== undefined ? j.next_cursor_str : j.next_cursor;
      const next = nextRaw === undefined || nextRaw === null ? '' : String(nextRaw);
      if (!next || next === '0' || next === '-1' || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
      await sleep(rand(settings.pageDelayMinMs, settings.pageDelayMaxMs));
    }
    return { ok: true, users: out, unknown, pages: page + 1 };
  } catch (e) {
    return { ok: false, users: out, unknown, pages: page + 1, error: safeErr(e) };
  }
}

async function buildFollowerSetRest(tabId, csrf, session, settings, scan) {
  const max = Math.min(10000, Math.max(3000, Number(settings.maxAccounts || 2500) * 2));
  const r = await collectListRest(tabId, csrf, 'followers', session, { ...settings, maxAccounts: max }, scan, { max });
  const set = new Set();
  for (const u of r.users || []) {
    if (u.id) set.add('id:' + u.id);
    set.add('h:' + u.handle.toLowerCase());
  }
  return { set, complete: r.ok && (r.users || []).length < max, error: r.error || '' };
}

async function resolveUnknownWithFollowersRest(tabId, csrf, session, settings, scan, users) {
  const unknownCount = users.filter((u) => u.followsYou === null).length;
  if (!unknownCount) return { unknown: 0, followerScan: null };
  scan.phase = '快速接口未返回全部回关字段，正在补查粉丝列表…';
  await persistScan(scan);
  const fs = await buildFollowerSetRest(tabId, csrf, session, settings, scan);
  let left = 0;
  for (const u of users) {
    if (u.followsYou !== null) continue;
    const hit = (u.id && fs.set.has('id:' + u.id)) || fs.set.has('h:' + u.handle.toLowerCase());
    if (hit) u.followsYou = true;
    else if (fs.complete) u.followsYou = false;
    else left++;
  }
  return { unknown: left, followerScan: fs };
}

// ---------- 页面滚动兼容模式 ----------
async function collectDomList(tabId, handle, kind, max, scan) {
  const liveTabId = await navigateTab(tabId, `https://x.com/${encodeURIComponent(handle)}/${kind}`);
  await sleep(1800);
  scan.phase = (kind === 'following' ? '兼容模式：正在滚动读取关注列表…' : '兼容模式：正在滚动读取粉丝列表…');
  await persistScan(scan);
  const r = await sendTab(liveTabId, { type: 'COLLECT_DOM_USERS', args: { kind, max } }, 4, 800);
  if (!r || !r.ok) return { ok: false, users: [], error: r ? r.msg : '页面采集无响应' };
  return { ok: true, users: r.users || [], limited: !!r.limited, atEnd: !!r.atEnd };
}

async function collectViaDom(tabId, session, settings, scan) {
  const maxFollowing = Math.max(20, Number(settings.maxAccounts || 2500));
  const maxFollowers = Math.min(10000, Math.max(3000, maxFollowing * 2));
  const following = await collectDomList(tabId, session.handle, 'following', maxFollowing, scan);
  if (!following.ok) throw new Error(following.error || '读取关注列表失败');
  const results = (following.users || []).map((u) => ({
    id: '',
    handle: u.handle,
    name: u.name || u.handle,
    avatar: u.avatar || '',
    followsYou: u.followsYou ? true : null,
    following: true,
  }));

  if (scanStopFlag) {
    return { ok: true, users: results, unknown: results.length, complete: false, stopped: true };
  }

  scan.phase = '兼容模式：关注列表已读取 ' + results.length + ' 人，正在读取粉丝列表做比对…';
  scan.progress = { phase: scan.phase, count: results.length, page: 0 };
  await persistScan(scan);

  const followers = await collectDomList(tabId, session.handle, 'followers', maxFollowers, scan);
  if (!followers.ok) {
    return { ok: false, users: results, error: followers.error || '读取粉丝列表失败', unknown: results.length };
  }
  const set = new Set((followers.users || []).map((u) => u.handle.toLowerCase()));
  const complete = !followers.limited;
  let unknown = 0;
  for (const u of results) {
    if (u.followsYou === true) continue;
    if (set.has(u.handle.toLowerCase())) u.followsYou = true;
    else if (complete) u.followsYou = false;
    else { u.followsYou = null; unknown++; }
  }
  return { ok: true, users: results, unknown, complete };
}

// ---------- 扫描主流程 ----------
function buildStats(users) {
  return {
    scanned: users.length,
    notFollowingBack: users.filter((u) => u.followsYou === false).length,
    mutual: users.filter((u) => u.followsYou === true).length,
    unknown: users.filter((u) => u.followsYou === null).length,
    unfollowed: users.filter((u) => u.unfollowed).length,
  };
}

function sortResults(users) {
  const rank = (u) => (u.unfollowed ? 3 : u.followsYou === false ? 0 : u.followsYou === null ? 1 : 2);
  return users.slice().sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d) return d;
    return String(a.handle || '').localeCompare(String(b.handle || ''), 'en');
  });
}

function dedupeUsers(users) {
  const map = new Map();
  for (const u of users || []) {
    const key = (u.id || u.handle || '').toLowerCase();
    if (!key) continue;
    if (!map.has(key)) map.set(key, u);
  }
  return [...map.values()];
}

async function finishScan(scan, users, source, warnings, fatalError) {
  scan.results = sortResults(dedupeUsers(users));
  scan.stats = buildStats(scan.results);
  scan.source = source || '';
  scan.warnings = warnings || [];
  scan.finishedAt = Date.now();
  if (fatalError && !scan.results.length) {
    scan.status = 'error';
    scan.error = fatalError;
  } else if (fatalError) {
    scan.status = 'partial';
    scan.error = fatalError;
  } else {
    scan.status = 'done';
    scan.error = '';
  }
  scan.phase = scan.status === 'done' ? '扫描完成' : (scan.status === 'partial' ? '扫描完成（部分数据）' : '扫描失败');
  await persistScan(scan);
}

async function runScan(scan, settings) {
  let tabId = null;
  const warnings = [];
  try {
    scan.status = 'running';
    scan.phase = '检查登录状态…';
    await persistScan(scan);

    if (!(await checkLogin())) throw new Error('没有检测到 X 登录 Cookie。请先在 Chrome 登录 x.com，再回到这里扫描。');
    const csrf = await getCsrfToken();
    if (!csrf) throw new Error('未找到 ct0 Cookie。请刷新 x.com 后重试。');

    scan.phase = '打开 X 工作页…';
    await persistScan(scan);
    tabId = await openXTab('https://x.com/home', false);
    const session = await getSession(tabId, csrf);
    if (!session.ok) throw new Error(session.msg || '读取账号失败');
    scan.account = {
      handle: session.handle,
      name: session.name,
      userId: session.userId,
      avatar: session.avatar,
    };
    if (session.warning) warnings.push(session.warning);
    scan.phase = '已登录 @' + session.handle + '，开始读取关注列表…';
    await persistScan(scan);

    let users = null;
    let source = '';

    if (settings.mode !== 'dom') {
      const rest = await collectListRest(tabId, csrf, 'friends', session, settings, scan);
      if (rest.ok || (rest.users && rest.users.length)) {
        users = rest.users || [];
        source = '快速接口';
        if (rest.error) warnings.push(rest.error);
        if (scanStopFlag) {
          await finishScan(scan, users, source, warnings, '');
          scan.status = 'stopped';
          scan.phase = '已停止（保留已读取的数据）';
          scan.finishedAt = Date.now();
          await persistScan(scan);
          return;
        }
        if (rest.unknown > 0) {
          try {
            const resolved = await resolveUnknownWithFollowersRest(tabId, csrf, session, settings, scan, users);
            if (resolved.unknown > 0) warnings.push('有 ' + resolved.unknown + ' 个账号无法确认回关状态');
            if (resolved.followerScan && resolved.followerScan.error) warnings.push('补查粉丝列表：' + resolved.followerScan.error);
          } catch (e) {
            warnings.push('补查粉丝列表失败：' + safeErr(e));
          }
        }
      } else {
        warnings.push('快速接口不可用，切换兼容模式：' + (rest.error || '未知原因'));
      }
    }

    if (users === null) {
      if (settings.mode === 'api') {
        throw new Error('快速接口不可用。请把扫描方式改为「自动」或「兼容模式」后重试。');
      }
      const dom = await collectViaDom(tabId, session, settings, scan);
      users = dom.users || [];
      source = '页面兼容模式';
      if (!dom.ok) warnings.push(dom.error || '粉丝列表读取不完整');
      if (dom.unknown > 0) warnings.push('粉丝列表未读完整，有 ' + dom.unknown + ' 个账号状态待确认');
    }

    if (scanStopFlag) {
      await finishScan(scan, users, source, warnings, '');
      scan.status = 'stopped';
      scan.phase = '已停止（保留已读取的数据）';
      scan.finishedAt = Date.now();
      await persistScan(scan);
      return;
    }

    await finishScan(scan, users, source, warnings, '');
  } catch (e) {
    if (e && e.name === 'StopError') {
      scan.status = 'stopped';
      scan.phase = '已停止';
      scan.finishedAt = Date.now();
      scan.stats = buildStats(scan.results || []);
      if (!scan.results) scan.results = [];
      await persistScan(scan);
    } else {
      await finishScan(scan, scan.results || [], scan.source || '', warnings, safeErr(e));
    }
  } finally {
    await closeTab(currentWorkTabId || tabId);
    currentWorkTabId = null;
    currentScan = scan;
    await persistScan(scan);
  }
}

async function startScan(requestSettings) {
  const existing = await getUsableScan();
  if (existing && existing.status === 'running') return { ok: false, msg: '已有扫描正在进行' };
  if (batchUnfollow && batchUnfollow.running) return { ok: false, msg: '正在批量取关，请稍后再扫描' };

  const saved = requestSettings ? await saveSettings(requestSettings) : await getSettings();
  scanStopFlag = false;
  const id = 'scan_' + Date.now().toString(36);
  currentScan = {
    id,
    status: 'running',
    phase: '准备扫描…',
    startedAt: Date.now(),
    finishedAt: 0,
    account: null,
    results: [],
    stats: { scanned: 0, notFollowingBack: 0, mutual: 0, unknown: 0, unfollowed: 0 },
    progress: { phase: '准备扫描…', count: 0, page: 0 },
    warnings: [],
    error: '',
    source: '',
  };
  await persistScan(currentScan);
  runScan(currentScan, saved).catch(async (e) => {
    currentScan.status = 'error';
    currentScan.error = safeErr(e);
    currentScan.phase = '扫描异常';
    await persistScan(currentScan);
  });
  return { ok: true, scanId: id };
}

// ---------- 取关 ----------
function withUnfollowLock(fn) {
  const p = unfollowLock.then(fn, fn);
  unfollowLock = p.catch(() => {});
  return p;
}

function findUser(scan, ref) {
  if (!scan || !Array.isArray(scan.results)) return null;
  const id = String(ref.id || '');
  const h = normalizeHandle(ref.handle || '').toLowerCase();
  return scan.results.find((u) => (id && String(u.id) === id) || (h && String(u.handle || '').toLowerCase() === h)) || null;
}

async function unfollowCore(tabId, csrf, user) {
  if (user.id) {
    const body = new URLSearchParams();
    body.set('user_id', String(user.id));
    body.set('include_profile_interstitial_type', '1');
    body.set('include_blocking', '1');
    body.set('include_blocked_by', '1');
    body.set('include_followed_by', '1');
    body.set('include_want_retweets', '1');
    body.set('include_mute_edge', '1');
    body.set('include_can_dm', '1');
    body.set('include_can_media_tag', '1');
    body.set('skip_status', '1');
    const r = await xFetch(tabId, csrf, {
      path: '/i/api/1.1/friendships/destroy.json',
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: body.toString(),
    });
    if (r && r.ok && r.json && !(r.json.errors && r.json.errors.length)) {
      const stillFollowing = r.json.following !== undefined
        ? boolOrNull(r.json.following)
        : boolOrNull(r.json.legacy && r.json.legacy.following);
      if (stillFollowing !== true) {
        return { ok: true, method: 'api', msg: '已通过接口取关' };
      }
    }
    // 接口失败时继续走页面点击兜底。
  }

  const liveTabId = await navigateTab(tabId, 'https://x.com/' + encodeURIComponent(user.handle));
  await sleep(1600);
  const r = await sendTab(liveTabId, { type: 'UNFOLLOW_PROFILE' }, 5, 700);
  if (!r) return { ok: false, msg: '页面取关无响应' };
  if (!r.ok) return { ok: false, msg: r.msg || '页面取关失败' };
  return { ok: true, method: 'dom', msg: r.msg || '已通过页面取关' };
}

async function doUnfollowUser(ref, existingTabId) {
  const scan = await getUsableScan();
  if (!scan || !scan.results || !scan.results.length) return { ok: false, msg: '还没有扫描结果' };
  if (scan.status === 'running') return { ok: false, msg: '扫描进行中，暂不执行取关' };
  const user = findUser(scan, ref);
  if (!user) return { ok: false, msg: '扫描结果中找不到这个账号' };
  if (user.unfollowed) return { ok: true, already: true, msg: '这个账号已经标记为已取关' };
  const wl = await getWhitelist();
  if (wl.includes(String(user.handle || '').toLowerCase())) {
    return { ok: false, msg: '该账号在保留名单中，请先取消保留' };
  }
  if (!(await checkLogin())) return { ok: false, msg: 'X 未登录' };
  const csrf = await getCsrfToken();
  if (!csrf) return { ok: false, msg: '未找到 ct0 Cookie' };

  let tabId = existingTabId;
  let ownTab = false;
  if (!tabId) {
    tabId = await openXTab('https://x.com/home', false);
    ownTab = true;
  }
  try {
    const r = await unfollowCore(tabId, csrf, user);
    if (r.ok) {
      user.unfollowed = true;
      user.unfollowedAt = Date.now();
      scan.stats = buildStats(scan.results);
      await persistScan(scan);
    }
    return r;
  } finally {
    if (ownTab) await closeTab(tabId);
  }
}

function enqueueSingleUnfollow(ref) {
  return withUnfollowLock(async () => {
    if (batchUnfollow && batchUnfollow.running) return { ok: false, msg: '批量取关进行中' };
    return await doUnfollowUser(ref, null);
  });
}

async function startBatchUnfollow(refs) {
  if (batchUnfollow && batchUnfollow.running) return { ok: false, msg: '批量取关已在进行中' };
  const scan = await getUsableScan();
  if (!scan || scan.status === 'running') return { ok: false, msg: '请先完成扫描' };
  const wl = new Set(await getWhitelist());
  const list = (Array.isArray(refs) ? refs : []).map((r) => findUser(scan, r)).filter(Boolean)
    .filter((u) => !u.unfollowed && !wl.has(String(u.handle || '').toLowerCase()));
  if (!list.length) return { ok: false, msg: '没有可操作的账号' };

  const csrf = await getCsrfToken();
  if (!csrf) return { ok: false, msg: '未找到 ct0 Cookie' };
  if (!(await checkLogin())) return { ok: false, msg: 'X 未登录' };

  const settings = await getSettings();
  batchStopFlag = false;
  batchUnfollow = { running: true, total: list.length, done: 0, success: 0, failed: 0, current: '', note: '', reopened: 0, startedAt: Date.now() };

  withUnfollowLock(async () => {
    let tabId = null;
    try {
      tabId = await openXTab('https://x.com/home', false);
      for (const user of list) {
        if (batchStopFlag) break;
        batchUnfollow.current = user.handle;
        const r = await unfollowCore(tabId, csrf, user);
        batchUnfollow.done++;
        if (r.ok) {
          batchUnfollow.success++;
          user.unfollowed = true;
          user.unfollowedAt = Date.now();
        } else {
          batchUnfollow.failed++;
          user.unfollowError = r.msg || '取关失败';
        }
        scan.stats = buildStats(scan.results);
        await persistScan(scan);
        if (batchUnfollow.done < batchUnfollow.total) {
          await sleep(rand(settings.unfollowDelayMinMs, settings.unfollowDelayMaxMs));
        }
      }
    } catch (e) {
      batchUnfollow.error = safeErr(e);
    } finally {
      batchUnfollow.running = false;
      batchUnfollow.current = '';
      batchUnfollow.finishedAt = Date.now();
      await closeTab(currentWorkTabId || tabId);
      currentWorkTabId = null;
    }
  });
  return { ok: true, batch: batchUnfollow };
}

// ---------- 消息入口 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || !msg.type) return { ok: false, msg: '空消息' };

      if (msg.type === 'DOM_SCAN_PROGRESS') {
        if (currentScan && currentScan.status === 'running') {
          currentScan.phase = (msg.kind === 'followers' ? '兼容模式：粉丝列表 ' : '兼容模式：关注列表 ') + '已读取 ' + (msg.count || 0) + ' 人…';
          currentScan.progress = { phase: currentScan.phase, count: msg.count || 0, page: 0 };
          await persistScan(currentScan);
        }
        return { ok: true };
      }

      if (msg.type === 'GET_STATE') {
        const scan = await getUsableScan();
        const settings = await getSettings();
        return {
          ok: true,
          scan,
          settings,
          whitelist: await getWhitelist(),
          batch: batchUnfollow,
          running: !!(scan && scan.status === 'running'),
          loggedIn: await checkLogin(),
        };
      }

      if (msg.type === 'START_SCAN') {
        return await startScan(msg.settings || null);
      }

      if (msg.type === 'STOP_SCAN') {
        scanStopFlag = true;
        if (currentWorkTabId) {
          sendTab(currentWorkTabId, { type: 'STOP_DOM_SCAN' }, 1, 100).catch(() => {});
        }
        const scan = await getUsableScan();
        if (scan && scan.status === 'running') {
          scan.phase = '正在停止…';
          await persistScan(scan);
        }
        return { ok: true };
      }

      if (msg.type === 'GET_SETTINGS') {
        return { ok: true, settings: await getSettings() };
      }

      if (msg.type === 'SAVE_SETTINGS') {
        return { ok: true, settings: await saveSettings(msg.settings || {}) };
      }

      if (msg.type === 'TOGGLE_KEEP') {
        const handle = normalizeHandle(msg.handle || '').toLowerCase();
        if (!handle) return { ok: false, msg: '缺少账号名' };
        const list = await getWhitelist();
        const set = new Set(list);
        if (msg.keep === false) set.delete(handle);
        else set.add(handle);
        const whitelist = await setWhitelist([...set]);
        return { ok: true, whitelist };
      }

      if (msg.type === 'UNFOLLOW_USER') {
        return await enqueueSingleUnfollow(msg.user || {});
      }

      if (msg.type === 'BATCH_UNFOLLOW') {
        return await startBatchUnfollow(msg.users || []);
      }

      if (msg.type === 'STOP_BATCH_UNFOLLOW') {
        batchStopFlag = true;
        return { ok: true };
      }

      if (msg.type === 'OPEN_X_PROFILE') {
        const handle = normalizeHandle(msg.handle || '');
        if (!handle) return { ok: false, msg: '缺少账号名' };
        await chrome.tabs.create({ url: 'https://x.com/' + encodeURIComponent(handle), active: true });
        return { ok: true };
      }

      return { ok: false, msg: '未知消息：' + msg.type };
    } catch (e) {
      return { ok: false, msg: safeErr(e) };
    }
  })().then(sendResponse);
  return true;
});

// 用户手动关掉工作页时：如果扫描或批量取关仍在进行，自动重开并继续。
chrome.tabs.onRemoved.addListener((closedTabId) => {
  if (closedTabId !== currentWorkTabId) return;
  currentWorkTabId = null;
  const scanRunning = !!(currentScan && currentScan.status === 'running');
  const batchRunning = !!(batchUnfollow && batchUnfollow.running);
  if (!scanRunning && !batchRunning) return;
  reopenWorkTab('closed-by-user').catch(async (e) => {
    if (batchUnfollow && batchUnfollow.running) {
      batchUnfollow.note = '工作页重开失败：' + safeErr(e);
    }
    if (currentScan && currentScan.status === 'running') {
      currentScan.phase = '工作页重开失败，正在尝试下一次自动恢复…';
      await persistScan(currentScan);
    }
  });
});

// 让 dashboard 的长连接在扫描时保持 service worker 活跃。
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'x-mutual-keepalive') return;
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === 'PING') {
      try { port.postMessage({ type: 'PONG', ts: Date.now() }); } catch (e) {}
    }
  });
});

