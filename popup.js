const $ = (s) => document.querySelector(s);
const msg = (m) => new Promise((resolve) => {
  try {
    chrome.runtime.sendMessage(m, (r) => resolve(chrome.runtime.lastError ? { ok: false } : (r || { ok: false })));
  } catch (e) { resolve({ ok: false }); }
});

async function init() {
  const r = await msg({ type: 'GET_STATE' });
  if (!r.ok) {
    $('#statusLine').textContent = '无法连接扩展后台';
    return;
  }
  const scan = r.scan;
  const badge = $('#loginBadge');
  if (r.loggedIn) {
    badge.className = 'badge good';
    badge.textContent = 'X 已登录';
  } else {
    badge.className = 'badge bad';
    badge.textContent = '未检测到 X 登录';
  }

  if (scan && Array.isArray(scan.results)) {
    const wl = new Set((r.whitelist || []).map((h) => String(h).toLowerCase()));
    const list = scan.results;
    $('#notBack').textContent = list.filter((u) => u.followsYou === false && !u.unfollowed && !wl.has(String(u.handle || '').toLowerCase())).length;
    $('#scanned').textContent = list.length;
    $('#mutual').textContent = list.filter((u) => u.followsYou === true && !u.unfollowed).length;
  }
  if (scan) {
    if (scan.status === 'running') $('#statusLine').textContent = scan.phase || '正在扫描…';
    else if (scan.status === 'done') $('#statusLine').textContent = '上次扫描完成 · ' + new Date(scan.finishedAt).toLocaleString('zh-CN');
    else if (scan.status === 'partial') $('#statusLine').textContent = '上次扫描仅部分完成：' + (scan.error || '');
    else if (scan.status === 'error') $('#statusLine').textContent = '上次扫描失败：' + (scan.error || '');
    else if (scan.status === 'stopped') $('#statusLine').textContent = '上次扫描已停止';
    if (scan.account && scan.account.handle) {
      $('#statusLine').title = '@' + scan.account.handle + ' · ' + $('#statusLine').textContent;
    }
  }
}

$('#openDashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html'), active: true });
  window.close();
});
$('#openX').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://x.com/home', active: true });
});
$('#openSettings').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html#settings'), active: true });
  window.close();
});
init();
