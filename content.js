// content.js — 在 x.com / twitter.com 页面内执行。
// 只负责：读取页面账号信息、代发 X 内部请求、兼容模式滚动采集、手动取关的页面点击兜底。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let domStopFlag = false;

const RESERVED = new Set([
  'home', 'explore', 'notifications', 'messages', 'bookmarks', 'settings', 'premium',
  'jobs', 'grok', 'search', 'lists', 'topics', 'communities', 'i', 'hashtag', 'login',
  'logout', 'signup', 'tos', 'privacy', 'compose', 'intent',
]);

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 2 && r.height > 2;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function getPageInfo() {
  let handle = '';
  const selectors = [
    'a[data-testid="AppTabBar_Profile_Link"]',
    'a[aria-label="Profile"]',
    'a[href^="/"][data-testid="AppTabBar_Profile_Link"]',
  ];
  for (const sel of selectors) {
    const a = document.querySelector(sel);
    if (!a) continue;
    const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/);
    if (m && !RESERVED.has(m[1].toLowerCase())) { handle = m[1]; break; }
  }

  // 侧边栏账号切换按钮的文本里也带 @handle。
  if (!handle) {
    const switchBtn = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (switchBtn) {
      const m = (switchBtn.innerText || switchBtn.textContent || '').match(/@([A-Za-z0-9_]{1,15})/);
      if (m) handle = m[1];
    }
  }

  const title = document.title || '';
  return {
    ok: true,
    handle,
    href: location.href,
    title,
    loggedInHint: !/login|i\/flow\/login/i.test(location.href),
  };
}

// 用页面自己的登录态请求 X 内部接口。页面上下文能自动带上 x.com 的 Cookie。
async function xFetch(args) {
  const path = String(args && args.path || '');
  if (!path.startsWith('/i/api/')) {
    return { ok: false, status: 0, msg: '拒绝非 X API 路径' };
  }
  const method = (args.method || 'GET').toUpperCase();
  const headers = {
    'accept': '*/*',
    'authorization': args.authorization || '',
    'x-csrf-token': args.csrf || '',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
  };
  if (!headers.authorization) delete headers.authorization;
  if (!headers['x-csrf-token']) delete headers['x-csrf-token'];
  if (args.contentType) headers['content-type'] = args.contentType;

  try {
    const res = await fetch(location.origin + path, {
      method,
      headers,
      credentials: 'include',
      body: method === 'GET' ? undefined : (args.body || ''),
      cache: 'no-store',
    });
    const text = await res.text();
    const json = safeJson(text);
    return {
      ok: res.ok,
      status: res.status,
      json,
      text: json ? '' : text.slice(0, 500),
      rateLimitReset: res.headers.get('x-rate-limit-reset') || '',
      rateLimitRemaining: res.headers.get('x-rate-limit-remaining') || '',
    };
  } catch (e) {
    return { ok: false, status: 0, msg: e && e.message ? e.message : '网络请求失败' };
  }
}

// 从 performance entries 中找当前页触发的 GraphQL 请求模板。
// 这是 X 内部接口快速模式的第二重兜底：不硬编码会过期的 queryId。
function getGraphqlTemplates() {
  const templates = {};
  for (const entry of performance.getEntriesByType('resource')) {
    const name = entry.name || '';
    const m = name.match(/\/i\/api\/graphql\/([^/]+)\/([^?]+)(?:\?|$)/);
    if (!m) continue;
    const op = decodeURIComponent(m[2]);
    if (!/^(Following|Followers)$/.test(op)) continue;
    try {
      const u = new URL(name);
      const rawVars = u.searchParams.get('variables') || '{}';
      templates[op] = {
        queryId: decodeURIComponent(m[1]),
        operation: op,
        variables: JSON.parse(rawVars),
        features: u.searchParams.get('features') || '',
        fieldToggles: u.searchParams.get('fieldToggles') || '',
      };
    } catch (e) {}
  }
  return { ok: true, templates };
}

function extractCellUser(cell) {
  let handle = '';
  for (const a of cell.querySelectorAll('a[href^="/"]')) {
    const path = (a.getAttribute('href') || '').split(/[?#]/)[0];
    const m = path.match(/^\/([A-Za-z0-9_]{1,15})$/);
    if (m && !RESERVED.has(m[1].toLowerCase())) { handle = m[1]; break; }
  }
  if (!handle) return null;

  const text = (cell.innerText || cell.textContent || '').replace(/\r/g, '');
  const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
  const name = lines[0] || handle;
  const img = cell.querySelector('img');
  const followsYou = /follows you|关注了你|回关了你|已回关/i.test(text);
  return {
    handle,
    name,
    avatar: img ? (img.currentSrc || img.src || '') : '',
    followsYou,
  };
}

async function collectDomUsers(args) {
  domStopFlag = false;
  const kind = args && args.kind === 'followers' ? 'followers' : 'following';
  const max = Math.max(20, Math.min(10000, Number(args && args.max) || 3000));
  const seen = new Map();
  let noGrowth = 0;
  let lastHeight = 0;
  let lastCount = 0;
  let step = 0;

  // 等待列表首屏。
  for (let i = 0; i < 24; i++) {
    if (domStopFlag) break;
    if (document.querySelectorAll('[data-testid="UserCell"]').length) break;
    await sleep(400);
  }

  while (!domStopFlag && step < 2500 && seen.size < max) {
    document.querySelectorAll('[data-testid="UserCell"]').forEach((cell) => {
      const u = extractCellUser(cell);
      if (!u) return;
      const key = u.handle.toLowerCase();
      if (!seen.has(key)) seen.set(key, u);
    });

    if (seen.size >= max) break;
    window.scrollTo(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
    await sleep(850 + Math.random() * 500);

    const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const count = document.querySelectorAll('[data-testid="UserCell"]').length;
    if (height <= lastHeight + 2 && count <= lastCount) {
      noGrowth++;
      if (noGrowth >= 4) break;
    } else {
      noGrowth = 0;
    }
    lastHeight = height;
    lastCount = count;
    step++;

    if (step % 4 === 0) {
      try {
        chrome.runtime.sendMessage({
          type: 'DOM_SCAN_PROGRESS',
          kind,
          count: seen.size,
        }).catch(() => {});
      } catch (e) {}
    }
  }

  return {
    ok: true,
    kind,
    users: [...seen.values()].slice(0, max),
    steps: step,
    limited: seen.size >= max,
    atEnd: noGrowth >= 4,
  };
}

// 页面点击取关兜底：只在 REST 取关失败时使用。
async function unfollowProfile() {
  for (let i = 0; i < 40; i++) {
    const scope = document.querySelector('[data-testid="primaryColumn"]') || document;
    const followBtns = [...scope.querySelectorAll('[data-testid$="-follow"]')];
    const unfollowBtns = [...scope.querySelectorAll('[data-testid$="-unfollow"]')];

    if (followBtns.some(isVisible) && !unfollowBtns.some(isVisible)) {
      return { ok: true, already: true, msg: '当前已经是未关注状态' };
    }

    const btn = unfollowBtns.find(isVisible) || unfollowBtns[0];
    if (btn) {
      try { btn.click(); } catch (e) {}
      await sleep(700);

      const confirm = document.querySelector('[data-testid="confirmationSheetConfirm"]')
        || [...document.querySelectorAll('[role="button"]')].find((el) => /^(取消关注|Unfollow)$/i.test((el.innerText || '').trim()));
      if (confirm) {
        try { confirm.click(); } catch (e) {}
        await sleep(1500);
      }

      for (let j = 0; j < 10; j++) {
        const s2 = document.querySelector('[data-testid="primaryColumn"]') || document;
        if (s2.querySelector('[data-testid$="-follow"]')) {
          return { ok: true, msg: '取关成功' };
        }
        await sleep(400);
      }
      return { ok: true, msg: '已点击取关，请刷新页面确认' };
    }
    await sleep(500);
  }
  return { ok: false, msg: '页面中找不到取关按钮，请手动打开主页处理' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || !msg.type) return { ok: false, msg: '空消息' };
      if (msg.type === 'PING') return { ok: true, info: getPageInfo() };
      if (msg.type === 'GET_PAGE_INFO') return getPageInfo();
      if (msg.type === 'X_FETCH') return await xFetch(msg.args || {});
      if (msg.type === 'GET_GRAPHQL_TEMPLATES') return getGraphqlTemplates();
      if (msg.type === 'COLLECT_DOM_USERS') return await collectDomUsers(msg.args || {});
      if (msg.type === 'UNFOLLOW_PROFILE') return await unfollowProfile();
      if (msg.type === 'STOP_DOM_SCAN') { domStopFlag = true; return { ok: true }; }
      return { ok: false, msg: '未知操作：' + msg.type };
    } catch (e) {
      return { ok: false, msg: e && e.message ? e.message : '脚本异常' };
    }
  })().then(sendResponse);
  return true;
});
