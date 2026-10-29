# Contributing

Issues and PRs are welcome.

- Bug reports: include your Chrome version, extension version, and steps to reproduce
- The codebase is plain JS (no build step): edit files and reload the extension to test
- Keep permissions minimal — any new permission needs justification in the PR

# Changelog

## v1.1.0
- Follower-count range filter + sorting (followers/following)
- Keep-list (persistent whitelist, excluded from batch unfollow)
- Auto-reopen work tab when accidentally closed
- CSV export with follower counts, verified status, bio

## v1.0.0
- Initial release: two-mode scan (internal API + DOM fallback)
- Tabs: not-following-back / mutual / unknown / kept / all / unfollowed
- Selective & batch unfollow with confirmation
