// dashboard.js — 结果控制台

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  scan: null,
  settings: null,
  batch: null,
  whitelist: new Set(),
  loggedIn: false,
  filter: 'notFollowing',
  search: '',
  minFollowers: '',
  maxFollowers: '',
  sortBy: 'default',
  selected: new Set(),
  busy: false,
  loaded: false,
};

let scanTimer = null;
let keepalivePort = null;
let keepaliveTimer = null;
let toastTimer = null;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function safeUrl(s) {
  const v = String(s || '');
  return /^https?:\/\//i.test(v) ? v : '';
}
function keyOf(u) {
  return (u && (u.id ? 'id:' + u.id : 'h:' + String(u.handle || '').toLowerCase())) || '';
}
function isKept(u) {
  return !!(u && state.whitelist.has(String(u.handle || '').toLowerCase()));
}
function countOf(u, key) {
  if (!u || u[key] === null || u[key] === undefined || u[key] === '') return null;
  const n = Number(u[key]);
  return Number.isFinite(n) ? n : null;
}
function fmtCount(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return n.toLocaleString('zh-CN');
}
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function sendMessage(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, msg: chrome.runtime.lastError.message });
        } else {
          resolve(res || { ok: false, msg: '后台无响应' });
        }
      });
    } catch (e) {
      resolve({ ok: false, msg: e && e.message ? e.message : '扩展通信失败' });
    }
  });
}
function showToast(text, ms = 3200) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}
function computeStats(results) {
  const list = Array.isArray(results) ? results : [];
  return {
    scanned: list.length,
    notFollowingBack: list.filter((u) => u.followsYou === false && !u.unfollowed && !isKept(u)).length,
    mutual: list.filter((u) => u.followsYou === true && !u.unfollowed).length,
    unknown: list.filter((u) => u.followsYou === null && !u.unfollowed && !isKept(u)).length,
    kept: list.filter((u) => isKept(u) && !u.unfollowed).length,
    unfollowed: list.filter((u) => u.unfollowed).length,
  };
}
function getStats() {
  return computeStats(state.scan && state.scan.results);
}
function getResults() {
  return (state.scan && Array.isArray(state.scan.results)) ? state.scan.results : [];
}
function getFiltered() {
  const q = state.search.trim().toLowerCase();
  const min = state.minFollowers === '' ? null : Number(state.minFollowers);
  const max = state.maxFollowers === '' ? null : Number(state.maxFollowers);
  const hasFollowerFilter = (min !== null && Number.isFinite(min)) || (max !== null && Number.isFinite(max));

  const rows = getResults().filter((u) => {
    if (q) {
      const hay = (String(u.handle || '') + ' ' + String(u.name || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (hasFollowerFilter) {
      const fc = countOf(u, 'followersCount');
      if (fc === null) return false;
      if (min !== null && Number.isFinite(min) && fc < min) return false;
      if (max !== null && Number.isFinite(max) && fc > max) return false;
    }
    if (state.filter === 'notFollowing') return u.followsYou === false && !u.unfollowed && !isKept(u);
    if (state.filter === 'mutual') return u.followsYou === true && !u.unfollowed;
    if (state.filter === 'unknown') return u.followsYou === null && !u.unfollowed && !isKept(u);
    if (state.filter === 'kept') return isKept(u) && !u.unfollowed;
    if (state.filter === 'unfollowed') return !!u.unfollowed;
    return true;
  });

  const nullLast = (a, b) => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return 0;
  };
  if (state.sortBy === 'followersAsc') {
    rows.sort((a, b) => nullLast(countOf(a, 'followersCount'), countOf(b, 'followersCount')) || countOf(a, 'followersCount') - countOf(b, 'followersCount'));
  } else if (state.sortBy === 'followersDesc') {
    rows.sort((a, b) => nullLast(countOf(a, 'followersCount'), countOf(b, 'followersCount')) || countOf(b, 'followersCount') - countOf(a, 'followersCount'));
  } else if (state.sortBy === 'followingAsc') {
    rows.sort((a, b) => nullLast(countOf(a, 'followingCount'), countOf(b, 'followingCount')) || countOf(a, 'followingCount') - countOf(b, 'followingCount'));
  } else if (state.sortBy === 'followingDesc') {
    rows.sort((a, b) => nullLast(countOf(a, 'followingCount'), countOf(b, 'followingCount')) || countOf(b, 'followingCount') - countOf(a, 'followingCount'));
  }
  return rows;
}

function renderLogin() {
  const el = $('#loginBadge');
  if (state.loggedIn) {
    el.className = 'badge badge-good';
    el.textContent = 'X 已登录';
  } else {
    el.className = 'badge badge-bad';
    el.textContent = '未检测到登录';
  }
}

function renderAccount() {
  const el = $('#accountLine');
  const a = state.scan && state.scan.account;
  if (a && a.handle) {
    el.innerHTML = '<span class="dot"></span><span>当前账号 <strong>@' + esc(a.handle) + '</strong>' +
      (a.name && a.name !== a.handle ? ' · ' + esc(a.name) : '') + '</span>';
  } else {
    el.innerHTML = '<span class="dot"></span><span>尚未扫描</span>';
  }
}

function renderProgress() {
  const scan = state.scan;
  const running = !!(scan && scan.status === 'running');
  const box = $('#progressBox');
  const scanBtn = $('#scanBtn');
  const stopBtn = $('#stopBtn');
  if (running) {
    box.classList.remove('hidden');
    const p = scan.progress || {};
    $('#progressText').textContent = scan.phase || '正在扫描…' + (p.count ? '（已读取 ' + p.count + ' 人）' : '');
  } else {
    box.classList.add('hidden');
  }
  scanBtn.disabled = running || state.busy || !!(state.batch && state.batch.running);
  scanBtn.textContent = running ? '扫描进行中…' : '开始扫描';
  stopBtn.classList.toggle('hidden', !running);
}

function renderNotice() {
  const el = $('#notice');
  const scan = state.scan;
  if (!scan) { el.classList.add('hidden'); return; }
  const warns = [];
  if (scan.error) warns.push(scan.error);
  if (Array.isArray(scan.warnings)) warns.push(...scan.warnings);
  if (!warns.length && scan.status === 'done' && scan.stats && scan.stats.unknown > 0) {
    warns.push('有 ' + scan.stats.unknown + ' 个账号的回关状态无法确认。建议切到兼容模式重新扫描，或逐条打开主页核实。');
  }
  if (!warns.length) { el.classList.add('hidden'); return; }
  el.className = 'notice' + (scan.status === 'error' ? ' error' : '');
  el.textContent = warns.filter(Boolean).slice(0, 4).join(' ｜ ');
  el.classList.remove('hidden');
}

function renderSideInfo() {
  const scan = state.scan;
  $('#lastScanTime').textContent = scan && scan.finishedAt ? fmtTime(scan.finishedAt) : (scan && scan.startedAt ? '扫描中…' : '—');
  if (!scan) {
    $('#lastScanSource').textContent = '还没有扫描记录';
  } else {
    const s = scan.source ? '来源：' + scan.source : '扫描中';
    $('#lastScanSource').textContent = s + (scan.stats ? ' · 待确认 ' + scan.stats.unknown + ' 人' : '');
  }
}

function renderStats() {
  const s = getStats();
  $('#statScanned').textContent = s.scanned || 0;
  $('#statNotFollowing').textContent = s.notFollowingBack || 0;
  $('#statMutual').textContent = s.mutual || 0;
  $('#statUnknown').textContent = s.unknown || 0;
  $('#statKept').textContent = s.kept || 0;
  $('#statUnfollowed').textContent = s.unfollowed || 0;
}

function renderTabs() {
  const list = getResults();
  const counts = {
    notFollowing: list.filter((u) => u.followsYou === false && !u.unfollowed && !isKept(u)).length,
    mutual: list.filter((u) => u.followsYou === true && !u.unfollowed).length,
    unknown: list.filter((u) => u.followsYou === null && !u.unfollowed && !isKept(u)).length,
    kept: list.filter((u) => isKept(u) && !u.unfollowed).length,
    all: list.length,
    unfollowed: list.filter((u) => u.unfollowed).length,
  };
  $('#tabNotFollowing').textContent = counts.notFollowing;
  $('#tabMutual').textContent = counts.mutual;
  $('#tabUnknown').textContent = counts.unknown;
  $('#tabKept').textContent = counts.kept;
  $('#tabAll').textContent = counts.all;
  $('#tabUnfollowed').textContent = counts.unfollowed;
  $$('.tab', $('#tabs')).forEach((b) => b.classList.toggle('active', b.dataset.filter === state.filter));
}

function statusBadge(user) {
  const kept = isKept(user) ? '<span class="status-tag status-kept">★ 已保留</span> ' : '';
  if (user.unfollowed) return kept + '<span class="status-tag">已取关</span>';
  if (user.followsYou === false) return kept + '<span class="status-tag status-no">没有回关</span>';
  if (user.followsYou === true) return kept + '<span class="status-tag status-yes">已回关</span>';
  return kept + '<span class="status-tag status-unknown">待确认</span>';
}

function avatar(user) {
  const src = safeUrl(user.avatar);
  const initial = esc(String(user.name || user.handle || '?').trim().slice(0, 1).toUpperCase() || '?');
  if (src) {
    return '<img class="avatar" src="' + esc(src) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' +
      '<span class="avatar avatar-fallback hidden">' + initial + '</span>';
  }
  return '<span class="avatar avatar-fallback">' + initial + '</span>';
}

function renderTable() {
  const body = $('#resultBody');
  const wrap = $('#tableWrap');
  const empty = $('#emptyState');
  const rows = getFiltered();
  const results = getResults();
  if (!rows.length) {
    body.innerHTML = '';
    if (results.length) {
      wrap.classList.add('hidden');
      empty.classList.remove('hidden');
      if (state.filter === 'unfollowed') {
        empty.querySelector('h3').textContent = '还没有已取关记录';
        empty.querySelector('p').textContent = '取关成功的账号会出现在这里。';
      } else if (state.filter === 'kept') {
        empty.querySelector('h3').textContent = '保留名单还是空的';
        empty.querySelector('p').textContent = '在「未回关」列表点「保留」，以后每次扫描都会自动排除。';
      } else if (state.minFollowers !== '' || state.maxFollowers !== '') {
        empty.querySelector('h3').textContent = '当前粉丝数范围没有结果';
        empty.querySelector('p').textContent = '调整粉丝数上下限，或点「清除筛选」查看全部。';
      } else {
        empty.querySelector('h3').textContent = '这个筛选下没有账号';
        empty.querySelector('p').textContent = '切换上方的筛选，或重新扫描一次。';
      }
    } else if (state.scan && state.scan.status === 'running') {
      wrap.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.querySelector('h3').textContent = '正在读取关注列表…';
      empty.querySelector('p').textContent = '结果会在读取过程中实时出现，请稍候。';
    } else {
      wrap.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.querySelector('h3').textContent = '还没有扫描结果';
      empty.querySelector('p').textContent = '点击上方「开始扫描」，先读取你的关注列表。';
    }
    return;
  }

  wrap.classList.remove('hidden');
  empty.classList.add('hidden');
  body.innerHTML = rows.map((u) => {
    const key = keyOf(u);
    const kept = isKept(u);
    const checked = state.selected.has(key) ? ' checked' : '';
    const disabled = (u.unfollowed || kept) ? ' disabled' : '';
    const classes = [u.unfollowed ? 'is-unfollowed' : '', kept ? 'is-kept' : ''].filter(Boolean).join(' ');
    const trClass = classes ? ' class="' + classes + '"' : '';
    const followers = countOf(u, 'followersCount');
    const following = countOf(u, 'followingCount');
    return '<tr' + trClass + ' data-key="' + esc(key) + '">' +
      '<td class="col-check"><input type="checkbox" class="js-select" data-key="' + esc(key) + '"' + checked + disabled + '></td>' +
      '<td><div class="user-cell">' + avatar(u) +
        '<div class="user-meta"><span class="user-name">' + esc(u.name || u.handle) + '</span>' +
        '<span class="user-handle">@' + esc(u.handle) + '</span></div></div></td>' +
      '<td>' + statusBadge(u) + '</td>' +
      '<td><div class="count-cell" title="粉丝 ' + esc(fmtCount(followers)) + ' / 关注 ' + esc(fmtCount(following)) + '">' +
        '<span class="count-main">' + esc(fmtCount(followers)) + '</span>' +
        '<span class="count-sep">/</span><span class="count-sub">' + esc(fmtCount(following)) + '</span></div></td>' +
      '<td class="col-actions">' +
        '<button class="btn btn-ghost row-btn js-open" type="button" data-handle="' + esc(u.handle) + '">打开主页</button>' +
        (u.unfollowed ? '' : '<button class="btn btn-ghost row-btn js-keep" type="button" data-handle="' + esc(u.handle) + '" data-keep="' + (kept ? 'false' : 'true') + '">' + (kept ? '取消保留' : '保留') + '</button>') +
        (u.unfollowed
          ? '<button class="btn btn-ghost row-btn" type="button" disabled>已取关</button>'
          : kept
            ? ''
            : '<button class="btn btn-danger-ghost row-btn js-unfollow" type="button" data-id="' + esc(u.id || '') + '" data-handle="' + esc(u.handle) + '">取关</button>') +
      '</td></tr>';
  }).join('');
}

function renderFollowerFilterHint() {
  const list = getResults();
  const missing = list.filter((u) => countOf(u, 'followersCount') === null).length;
  const active = state.minFollowers !== '' || state.maxFollowers !== '';
  const hint = $('#followerFilterHint');
  if (active) {
    hint.textContent = '粉丝数筛选中' + (missing ? '；' + missing + ' 人无粉丝数数据，已隐藏' : '');
  } else if (missing) {
    hint.textContent = missing + ' 人无粉丝数数据（页面兼容模式常见）';
  } else {
    hint.textContent = '';
  }
}

function renderBatch() {
  const rows = getFiltered().filter((u) => !u.unfollowed && !isKept(u));
  for (const key of [...state.selected]) {
    const u = getResults().find((x) => keyOf(x) === key);
    if (!u || u.unfollowed || isKept(u)) state.selected.delete(key);
  }
  const selectedUsers = getResults().filter((u) => state.selected.has(keyOf(u)) && !u.unfollowed && !isKept(u));
  $('#selectedCount').textContent = '已选 ' + selectedUsers.length + ' 人';
  $('#batchBtn').disabled = !selectedUsers.length || state.busy || !!(state.batch && state.batch.running) || !!(state.scan && state.scan.status === 'running');
  $('#clearSelectedBtn').disabled = !selectedUsers.length;

  const selectable = rows.length;
  const selectedVisible = rows.filter((u) => state.selected.has(keyOf(u))).length;
  const cb = $('#selectAll');
  cb.disabled = !selectable || !!(state.batch && state.batch.running);
  cb.checked = selectable > 0 && selectedVisible === selectable;
  cb.indeterminate = selectedVisible > 0 && selectedVisible < selectable;

  const b = state.batch;
  const p = $('#batchProgress');
  if (b && b.running) {
    p.textContent = '取关中 ' + b.done + '/' + b.total + (b.current ? ' · @' + b.current : '') + (b.note ? ' · ' + b.note : '');
  } else if (b && b.finishedAt) {
    p.textContent = '上次批量：成功 ' + b.success + '，失败 ' + b.failed + (b.reopened ? ' · 自动恢复工作页 ' + b.reopened + ' 次' : '');
  } else {
    p.textContent = '';
  }
}

function renderAll() {
  renderLogin();
  renderAccount();
  renderProgress();
  renderNotice();
  renderSideInfo();
  renderStats();
  renderTabs();
  renderTable();
  renderFollowerFilterHint();
  renderBatch();
}

async function loadState(silent) {
  const res = await sendMessage({ type: 'GET_STATE' });
  if (!res || !res.ok) {
    if (!silent) showToast(res && res.msg ? res.msg : '无法读取扩展状态');
    return;
  }
  state.scan = res.scan || null;
  state.settings = res.settings || null;
  state.batch = res.batch || null;
  state.whitelist = new Set((res.whitelist || []).map((h) => String(h).toLowerCase()));
  state.loggedIn = !!res.loggedIn;
  state.loaded = true;

  // 清掉已经不存在的选择项
  const valid = new Set(getResults().map(keyOf));
  for (const k of [...state.selected]) if (!valid.has(k)) state.selected.delete(k);

  if (state.settings) {
    if (document.activeElement !== $('#maxAccounts')) $('#maxAccounts').value = state.settings.maxAccounts || 2500;
    if (document.activeElement !== $('#mode')) $('#mode').value = state.settings.mode || 'auto';
  }
  renderAll();
}

function setupEvents() {
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || !img.matches || !img.matches('img.avatar')) return;
    img.classList.add('hidden');
    const fallback = img.nextElementSibling;
    if (fallback && fallback.classList.contains('avatar-fallback')) fallback.classList.remove('hidden');
  }, true);

  $('#scanBtn').addEventListener('click', async () => {
    if (state.busy) return;
    const maxAccounts = Math.max(20, Math.min(10000, Number($('#maxAccounts').value) || 2500));
    const mode = $('#mode').value || 'auto';
    if (maxAccounts > 5000 && mode === 'dom') {
      const ok = await confirmDialog('兼容模式人数较多', '兼容模式需要滚动页面，' + maxAccounts + ' 人可能要花很久。确定继续吗？', '继续扫描');
      if (!ok) return;
    }
    state.busy = true;
    state.selected.clear();
    renderAll();
    $('#scanBtn').textContent = '正在启动…';
    const res = await sendMessage({ type: 'START_SCAN', settings: { maxAccounts, mode } });
    state.busy = false;
    if (!res.ok) {
      showToast(res.msg || '启动扫描失败');
      await loadState(true);
      return;
    }
    showToast('扫描已开始。扫描期间可以停留在本页查看进度。');
    await loadState(true);
  });

  $('#stopBtn').addEventListener('click', async () => {
    const ok = await confirmDialog('停止扫描？', '已读取的数据会保留，但结果可能不完整。', '停止扫描');
    if (!ok) return;
    const res = await sendMessage({ type: 'STOP_SCAN' });
    showToast(res.ok ? '正在停止…' : (res.msg || '停止失败'));
    await loadState(true);
  });

  $('#openHomeBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://x.com/home', active: true });
  });

  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    state.filter = btn.dataset.filter || 'notFollowing';
    renderAll();
  });

  $('#searchInput').addEventListener('input', (e) => {
    state.search = e.target.value || '';
    renderTable();
    renderFollowerFilterHint();
    renderBatch();
  });

  $('#minFollowers').addEventListener('input', (e) => {
    state.minFollowers = e.target.value;
    renderTable();
    renderFollowerFilterHint();
    renderBatch();
  });
  $('#maxFollowers').addEventListener('input', (e) => {
    state.maxFollowers = e.target.value;
    renderTable();
    renderFollowerFilterHint();
    renderBatch();
  });
  $('#sortBy').addEventListener('change', (e) => {
    state.sortBy = e.target.value || 'default';
    renderTable();
    renderBatch();
  });
  $('#clearFollowerFilter').addEventListener('click', () => {
    state.minFollowers = '';
    state.maxFollowers = '';
    state.sortBy = 'default';
    $('#minFollowers').value = '';
    $('#maxFollowers').value = '';
    $('#sortBy').value = 'default';
    renderTable();
    renderFollowerFilterHint();
    renderBatch();
  });

  $('#selectAll').addEventListener('change', (e) => {
    const rows = getFiltered().filter((u) => !u.unfollowed && !isKept(u));
    if (e.target.checked) rows.forEach((u) => state.selected.add(keyOf(u)));
    else rows.forEach((u) => state.selected.delete(keyOf(u)));
    renderTable();
    renderBatch();
  });

  $('#clearSelectedBtn').addEventListener('click', () => {
    state.selected.clear();
    renderTable();
    renderBatch();
  });

  $('#resultBody').addEventListener('change', (e) => {
    const cb = e.target.closest('.js-select');
    if (!cb) return;
    const key = cb.dataset.key;
    if (cb.checked) state.selected.add(key);
    else state.selected.delete(key);
    renderBatch();
  });

  $('#resultBody').addEventListener('click', async (e) => {
    const openBtn = e.target.closest('.js-open');
    if (openBtn) {
      const r = await sendMessage({ type: 'OPEN_X_PROFILE', handle: openBtn.dataset.handle });
      if (!r.ok) showToast(r.msg || '打开主页失败');
      return;
    }

    const keepBtn = e.target.closest('.js-keep');
    if (keepBtn) {
      const handle = keepBtn.dataset.handle;
      const keep = keepBtn.dataset.keep === 'true';
      keepBtn.disabled = true;
      const r = await sendMessage({ type: 'TOGGLE_KEEP', handle, keep });
      if (r.ok) {
        state.whitelist = new Set((r.whitelist || []).map((h) => String(h).toLowerCase()));
        state.selected.delete(keepBtn.closest('tr').dataset.key);
        showToast(keep ? '@' + handle + ' 已加入保留名单' : '@' + handle + ' 已取消保留');
        renderAll();
      } else {
        showToast(r.msg || '更新保留名单失败');
      }
      return;
    }

    const btn = e.target.closest('.js-unfollow');
    if (!btn) return;
    const handle = btn.dataset.handle;
    const ok = await confirmDialog('确认取关 @' + handle + '？', '这会在你的 X 账号上执行真实的取关操作。扩展先尝试接口，失败时会打开主页点按钮兜底。', '确认取关');
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = '处理中…';
    const r = await sendMessage({ type: 'UNFOLLOW_USER', user: { id: btn.dataset.id || '', handle } });
    if (r.ok) showToast('@' + handle + ' ' + (r.msg || '已取关'));
    else showToast('@' + handle + ' 取关失败：' + (r.msg || '未知错误'));
    state.selected.delete(btn.closest('tr').dataset.key);
    await loadState(true);
  });

  $('#batchBtn').addEventListener('click', async () => {
    if (state.busy) return;
    const users = getResults().filter((u) => state.selected.has(keyOf(u)) && !u.unfollowed && !isKept(u));
    if (!users.length) return;
    const ok = await confirmDialog('批量取关 ' + users.length + ' 个账号？', '这会逐个执行真实取关，并带有随机间隔。建议先在「未回关」列表里确认名单无误。', '开始批量取关');
    if (!ok) return;
    const res = await sendMessage({
      type: 'BATCH_UNFOLLOW',
      users: users.map((u) => ({ id: u.id || '', handle: u.handle })),
    });
    if (!res.ok) {
      showToast(res.msg || '批量取关启动失败');
      return;
    }
    state.selected.clear();
    showToast('批量取关已开始，可在结果区查看进度。');
    await loadState(true);
  });

  $('#exportBtn').addEventListener('click', () => {
    const rows = getFiltered();
    if (!rows.length) { showToast('当前列表没有可导出的数据'); return; }
    const header = ['handle', 'name', 'follows_you', 'followers_count', 'following_count', 'kept', 'unfollowed', 'verified', 'bio', 'profile_url'];
    const lines = [header.join(',')].concat(rows.map((u) => [
      '@' + u.handle,
      u.name || '',
      u.followsYou === false ? 'no' : u.followsYou === true ? 'yes' : 'unknown',
      countOf(u, 'followersCount') === null ? '' : countOf(u, 'followersCount'),
      countOf(u, 'followingCount') === null ? '' : countOf(u, 'followingCount'),
      isKept(u) ? 'yes' : 'no',
      u.unfollowed ? 'yes' : 'no',
      u.verified ? 'yes' : 'no',
      u.bio || '',
      'https://x.com/' + u.handle,
    ].map(csvCell).join(',')));
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'x-mutual-check-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });

  $('#confirmCancel').addEventListener('click', () => finishConfirm(false));
  $('#confirmOk').addEventListener('click', () => finishConfirm(true));
  $('#confirmOverlay').addEventListener('click', (e) => { if (e.target === $('#confirmOverlay')) finishConfirm(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#confirmOverlay').classList.contains('hidden')) finishConfirm(false);
  });
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return '"' + s.replace(/"/g, '""') + '"';
}

let confirmResolve = null;
function confirmDialog(title, text, okText) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = okText || '确认';
  $('#confirmOverlay').classList.remove('hidden');
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function finishConfirm(v) {
  $('#confirmOverlay').classList.add('hidden');
  if (confirmResolve) {
    const r = confirmResolve;
    confirmResolve = null;
    r(!!v);
  }
}

function setupWatchers() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.scan && changes.scan.newValue) {
        state.scan = changes.scan.newValue;
        renderAll();
      }
      if (changes.settings && changes.settings.newValue) {
        state.settings = changes.settings.newValue;
        if (document.activeElement !== $('#maxAccounts')) $('#maxAccounts').value = state.settings.maxAccounts || 2500;
        if (document.activeElement !== $('#mode')) $('#mode').value = state.settings.mode || 'auto';
      }
      if (changes.whitelist) {
        state.whitelist = new Set((changes.whitelist.newValue || []).map((h) => String(h).toLowerCase()));
        renderAll();
      }
    });
  } catch (e) {}

  if (scanTimer) clearInterval(scanTimer);
  scanTimer = setInterval(() => {
    const running = !!(state.scan && state.scan.status === 'running');
    const batchRunning = !!(state.batch && state.batch.running);
    if (running || batchRunning) loadState(true);
  }, 1400);

  try {
    keepalivePort = chrome.runtime.connect({ name: 'x-mutual-keepalive' });
    keepalivePort.onMessage.addListener(() => {});
    keepaliveTimer = setInterval(() => {
      try { keepalivePort.postMessage({ type: 'PING' }); } catch (e) {}
    }, 15000);
  } catch (e) {}
}

window.addEventListener('beforeunload', () => {
  if (scanTimer) clearInterval(scanTimer);
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  try { if (keepalivePort) keepalivePort.disconnect(); } catch (e) {}
});

setupEvents();
setupWatchers();
loadState(false);
