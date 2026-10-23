# Contributing

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Before you start

- For anything larger than a small fix, please open an issue first so we can agree on the approach.
- Security problems: do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## Development

```bash
npm install
npx playwright-core install chromium   # browser for the tests (first time only)
AUTH_PASSWORD=test npm start           # http://127.0.0.1:8888
```

- Server code lives in `lib/`, the browser app in `public/app/` — files are concatenated in numeric order into one script, so a new module gets a number after the modules it depends on. Restart the server after front-end changes.
- The terminal daemon is in `sshwebd/` (Go; Windows ConPTY + Linux pty). After changing it run `npm test -- sshwebd daemonwin daemonlinux daemonauto`.
- Code comments and UI text are currently in Chinese; English is fine in your contributions.

## Tests

```bash
npm test               # everything (about 15 minutes)
npm test -- desk lat   # only test/desk.test.js and test/lat.test.js
```

Each test starts its own server on a random 127.0.0.1 port with a temporary data directory and talks to mock SSH servers — nothing touches real hosts. Please add or update a test for any behaviour you change; CI (on the public repo) runs the whole suite on every pull request.

## Pull requests

- Keep each pull request focused on one change and describe what it changes and why.
- Never include passwords, keys, real host names, IPs or personal paths in code, tests or screenshots. Use `example.com`, `192.168.1.x` and similar placeholders.
- By contributing you agree that your work is released under the [MIT License](LICENSE).

---

欢迎反馈问题、提建议和提交 PR。较大的改动请先开 issue 商量；安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。开发和测试方法见上面，提交前请确保 `npm test` 通过，并且代码、测试、截图里没有密码、密钥、真实主机名和 IP。
