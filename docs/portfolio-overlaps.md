# Portfolio overlaps (document only)

OmniDev Hub is a **local merge/verify control plane** for coding-agent Git worktrees. After [#1](https://github.com/abhishekSF/omnidev-hub/pull/1) it is not a multi-machine fleet product, not a privacy classifier, and not a replacement for Cursor’s own apps. One host. One repo at a time. The merge gate is the product.

This note lists **observed** overlap with other repositories under [abhishekSF](https://github.com/abhishekSF). It does not invent sibling packages, extract shared libraries, or claim capabilities that are not in this tree.

## Classification

| Layer | What exists in this repo |
| --- | --- |
| Control plane | TypeScript Node daemon (`daemon/src/server.ts`) + phone PWA |
| Merge gate | Isolated worktree → freeze candidate SHA → designated verifier (tree write-protected) → approve **that** SHA |
| Auth | Pairing code / Bearer + HttpOnly `SameSite=Strict` session cookie. Query-string tokens are rejected. |
| Allowlist | Explicit `RepositoryRegistry` with `fs.realpathSync`. cwd is not trusted. |
| Persistence | Pending approvals in `~/.omnidev/state.json`; worktrees kept across daemon restart |
| Privacy fence | Heuristic `PrivacyPolicyEngine` (secret files / remotes). README: not a real model router. |
| Keep-awake | Bounded leases: `caffeinate` / `systemd-inhibit` / `SetThreadExecutionState`. Lid+battery refuses a lease. |

## Observed sibling themes

Themes below are taken from those repos’ public (or owner-visible) descriptions. Private repos are named only as the owner’s own inventory.

### Local-first / on-device

- **kernel** — local-first pomodoro; stats in `localStorage`; Witness extension has no network code.
- **cadence** / **cadence-dictation** — on-device macOS dictation; “audio stays on this Mac.”
- **omnidev-hub** — loopback daemon, token file under `~/.omnidev`, no cloud control plane.

Shared *idea*: keep secrets and raw data on the host. Not a shared module. Kernel’s privacy table and OmniDev’s pairing cookie solve different threats (telemetry vs. daemon auth).

### Voice as input, not as authority

- **omnidev-hub PWA** — Web Speech fills the prompt box; it does not submit.
- **indic-explain-aloud** — paste English, hear Hindi/Telugu.
- **voice-memo-note** (private) — voice memos.
- **cadence** — dictation, not a command channel.

Do not unify these. Different capture paths (Web Speech vs. on-device ASR vs. TTS). A shared “voice SDK” would be premature.

### Agent / model routing (different jobs)

- **sfstack** (private) — Salesforce skill tree: org alias, sandbox-only writes, verify commands as the done condition.
- **codenotch-switch** — visual Gemini/ChatGPT/Grok switcher; demo numbers, not a live quota client.
- **omnidev-hub** — engine chips grey out when the CLI is missing on PATH; `auto` still means Cursor for coding. Not a privacy classifier.

sfstack’s “a change is unfinished until verify commands have real output” is the closest doctrinal overlap with OmniDev’s designated verifier. The implementations are not interchangeable (Salesforce CLI vs. `git merge --no-ff <sha>`).

### Host / hardware tooling

- **MacMedic** — Intel Mac menu bar: SMC temps, battery trends, SIGTERM then SIGKILL for processes, confirmation before signalling system-critical PIDs.
- **omnidev-hub** — backpack interlock, process-group SIGTERM→SIGKILL before deleting a worktree, keep-awake leases.

Possible later reuse (not extracted): a tiny “confirm then escalate signals” helper, and Linux/macOS battery+lid readers. MacMedic is Python/PyObjC; OmniDev is Node. Copying either into a third language now would be busywork.

### Web control surfaces

Public TypeScript/JS apps (chakna, slackwater, PurePetrolHyd, BeforeSetup, customer-case-portal, livequiz, hydlab, NalaNow, salesforce-city-visualizer, bookmyshow-ticket-gallery, asmgkr-internet-guide) are product UIs. OmniDev’s PWA is a daemon skin (pairing overlay, repo allowlist, SHA approval). Tailwind-on-CDN is the only accidental visual overlap; do not share a component kit.

## What not to extract yet

| Tempting extract | Why not |
| --- | --- |
| Pairing + session cookie | OmniDev-specific (local daemon, 6-char code, 10-minute pairing TTL). |
| `RepositoryRegistry` realpath allowlist | Tied to git worktrees and `OMNIDEV_ALLOWED_REPOS`. |
| `commandToArgv` | Ten lines. Callers should prefer argv arrays in their own config. |
| Keep-awake manager | Platform spawn wrappers; MacMedic already talks to SMC directly. |
| Custom test harness | Replace later with a real runner; do not wrap it as a portfolio framework. |

## Next shared-infra opportunities (when a second consumer exists)

1. **Verify-before-merge contract** — sfstack (org verify) and OmniDev (candidate SHA) both refuse to claim green without a designated check. A *written* contract in a gist or principle file is enough; a npm package is not.
2. **Host safety interlocks** — lid+battery, confirm-then-kill. Only worth a module if MacMedic or another host tool needs the same Node API.
3. **Token-off-the-URL pairing** — any future local PWA talking to a loopback daemon can copy `daemon/src/auth/` rather than depending on this repo.

Until a second repo actually imports one of these, keep the copies honest and separate.
