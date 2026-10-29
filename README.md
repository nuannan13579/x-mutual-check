# 推特检测批量互关插件 — X Mutual-Follow Checker (Chrome Extension)

**[中文说明](#中文说明) | English**

Find accounts **you follow but who don't follow you back** on X (Twitter) — then decide, one by one, whom to unfollow.

![version](https://img.shields.io/badge/version-1.1.0-blue) ![manifest](https://img.shields.io/badge/Manifest-V3-green) ![privacy](https://img.shields.io/badge/privacy-100%25_local-orange)

## Why

X has no built-in way to see "who didn't follow me back". You follow hundreds of accounts during growth campaigns, and cleaning them up manually is painful. This extension scans your following list and marks exactly who follows you back — mutual / not-following-back / unknown — with a full dashboard for selective unfollowing.

## Features

- 🔍 **Two scan modes**: fast internal API first, automatic fallback to page-scrolling DOM mode
- 📊 **Follower-count filter & sort** — e.g. only show accounts with 100–2000 followers
- ⭐ **Keep-list**: whitelist accounts you never want to unfollow (persists across scans)
- ✅ **Selective unfollow**: one-by-one with confirmation, or batch with random delays
- 📈 Auto re-open work tab if you accidentally close it
- 📤 CSV export (handle, name, follower count, kept/unfollowed status…)
- 🔒 100% local — no server, no tracking, data stays in `chrome.storage.local`

## Install

1. Open `chrome://extensions`, enable **Developer mode**
2. **Load unpacked** → select this folder
3. Make sure you're logged in to [x.com](https://x.com) in this Chrome profile
4. Click the extension icon → **Open Dashboard** → **Start Scan**

📖 **Detailed tutorial (中文详细教程，含常见问题): [TUTORIAL.md](TUTORIAL.md)**

## How it works

```
Dashboard
  └─ background.js
       ├─ Fast mode: X internal friends/list API (uses your logged-in session)
       │    · each user entry includes followed_by flag
       └─ Fallback mode: scroll & parse /following and /followers pages
Unfollow: tries internal API first, falls back to clicking the button on the profile page
```

Requires only the permissions it needs: `storage`, `cookies`, `tabs` — restricted to `https://x.com/*` and `https://twitter.com/*`.

## Disclaimer

- This is an **unofficial** tool. It uses X's internal web endpoints, which may break when X changes its frontend.
- The bearer token in the code is a **public constant** embedded in every X web client (visible to anyone in DevTools). It is not a personal credential; authentication relies on your own browser cookies.
- Mass unfollowing may violate X's automation rules and carries account risk. Use sparingly and at your own risk.
- **No warranty.** For educational purposes. Respect X's Terms of Service.

## License

MIT — see [LICENSE](LICENSE)

---

<a name="中文说明"></a>
# X 互关检测器（Chrome 扩展）

找出你关注了、但对方没有回关你的 X 账号，自己挑选是否取关。

## 功能

- 双模式扫描：快速接口优先，失败自动降级页面滚动采集
- 粉丝数上下限二次筛选 + 按粉丝/关注数排序
- 保留名单：标记的账号跨扫描永不取关
- 逐条取关（带确认）/ 勾选批量取关（随机间隔）
- 工作页被误关自动重开
- CSV 导出；数据 100% 本地存储

## 安装

1. `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选本目录
2. 登录 x.com → 点扩展图标 → 打开检测面板 → 开始扫描

## 免责声明

非官方工具，使用 X 网页内部接口，X 改版后可能失效；代码中的 Bearer 为 X 网页端公开常量（非个人凭据）。批量取关可能违反 X 自动化条款，请克制使用，风险自担。
