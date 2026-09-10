# OmniDev Hub

Local merge/verify control plane for coding agents.

A phone-friendly PWA talks to a daemon on your machine. Agents write in an isolated Git worktree. The daemon freezes a candidate commit, runs a designated check against that SHA, and will only merge **that exact object** after you approve it.

This is **not** a multi-machine fleet product, not a privacy classifier, and not a replacement for Orca, Paseo, or Cursor’s own apps. One host. One repo at a time. The merge gate is the product.

## What it actually does

- Isolates each task in `git worktree`
- Freezes the result with `git add -A` and a candidate SHA
- Runs a designated verifier with the tree write-protected
- Binds Approve to that SHA (`git merge --no-ff <sha>`)
- Rejects stale approvals, destination HEAD drift, dirty trees, and unverified merges (unless you check the box)
- Survives a daemon restart: pending approvals are written to `~/.omnidev/state.json` and the worktree is kept
- Requires an **explicit** repo allowlist (cwd is not trusted)
- Pairs the PWA with a short-lived code or Bearer token — **not** `?token=` in the URL

## What it does not do yet

- Multi-host scheduling or “fleet” orchestration
- A real model/privacy router (engine chips that are missing on PATH are greyed out; `auto` still means Cursor for coding)
- Sandboxing the agent process (`--force` is still host-level; a worktree is not a container)
- Native iOS app, service worker, or pretty line-level diffs

## Quick start

```bash
cd daemon
npm install
npm test
```

Register the git repo you want the daemon to touch:

```bash
cd daemon
npx tsx src/cli.ts repo add /path/to/your/repo
```

Or set `OMNIDEV_ALLOWED_REPOS` (colon-separated on Unix).

Start the daemon on loopback:

```bash
cd daemon
HOST=127.0.0.1 npm start
```

On first run the daemon writes `~/.omnidev/token` and prints a **pairing code** once to stderr. Open `http://127.0.0.1:3842`, enter that code, then review/approve from the phone on the same Tailscale or LAN interface you bind.

Do not put the token in the query string. `Authorization: Bearer` and the session cookie are the supported auth paths.

### Optional env

| Variable | Meaning |
| --- | --- |
| `OMNIDEV_TOKEN` | Use this token instead of `~/.omnidev/token` |
| `OMNIDEV_HOME` | State directory (default `~/.omnidev`) |
| `OMNIDEV_ALLOWED_REPOS` | Extra allowlisted roots |
| `HOST` / `PORT` | Bind address (default `127.0.0.1:3842`) |

## Verification config

In the target repo, `.omnidev/config.json`:

```json
{
  "verification": { "command": ["npm", "test", "--", "--runInBand"] }
}
```

A string command is still accepted and split on spaces. Prefer an argv array. If no command (and no `package.json` `scripts.test`) is present, the candidate is `UNVERIFIED` and merge requires an explicit ack.

## Project layout

```
omnidev-hub/
├── daemon/               # TypeScript daemon
│   └── src/
│       ├── adapters/    # CLI spawn wrappers (cursor, agy, opencode)
│       ├── auth/         # Token, pairing, session cookie
│       ├── compiler/     # Pipeline + privacy policy
│       ├── fleet/        # Hardware profile + keep-awake
│       ├── repos/        # Explicit allowlist
│       ├── state/        # Pending-approval persistence
│       ├── worktree/     # Isolate / freeze / merge
│       └── server.ts
├── pwa/                  # Phone control surface
├── docs/                 # Conversation notes, portfolio overlaps (no extra product claims)
└── tests/verify-engine.ts
```

## Keep-awake

Bounded leases while a task is active:

- macOS: `caffeinate`
- Linux: `systemd-inhibit`
- Windows: `SetThreadExecutionState`

Lid-closed + battery refuses a new lease. On Linux, battery status comes from `/sys/class/power_supply` and lid state from `/proc/acpi/button/lid` when those nodes exist. That is not a firmware override of sleep or thermal policy.

## License

MIT. See `LICENSE`.
