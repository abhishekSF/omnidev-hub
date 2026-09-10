# OmniDev Hub — conversation notes

**Date:** Tuesday, 8 September 2026  
**Repo:** [abhishekSF/omnidev-hub](https://github.com/abhishekSF/omnidev-hub)  
**Commit reviewed:** `c4b4be1` (initial commit, 7 Sep 2026)

Cleaned transcript of critiques, next steps, glossary, and competitive landscape. Tool internals omitted.

---

## 1. Check the repo and critique

One-commit public repo: TypeScript daemon + mobile PWA + a custom 19-suite harness. Not empty, not a template. It already has a point of view.

A local control plane for coding agents: isolate work in a git worktree, plan with Anti-Gravity (`agy`), code with Cursor CLI (`agent`) / OpenCode / Freebuff, freeze a candidate commit, run a designated test with the tree locked read-only, then merge **that exact SHA** from a phone UI.

The interesting idea is not “another agent.” It is **gated execution**: backpack interlock, repo allowlist, privacy fence, candidate freeze, stale-approval reject, destination-HEAD check, unverified merge requires an explicit ack.

**Verdict at `c4b4be1`:** unusually complete for a day-old spike. The merge/verification contract is the thing. As a public product: unfinished and slightly over-named. Fleet, privacy router, smart compiler — only worktree + approval + a thin HTTP/WS shell were real.

Three things to lock:

1. Make engine selection real, or remove the chips.
2. Move the token off the query string; register repos explicitly; add a license.
3. Persist task + candidate SHA so a daemon restart does not orphan worktrees.

---

## 2. Next steps (build order)

The merge/verify path is the product. Do not add more engines until a human can run one real task from the phone, restart the daemon, and still approve the same SHA.

Slice 1 (survivable loop) and the README-honesty parts of Slice 2 are in `main` as of `#1`. This follow-up is Slice 3 hygiene only. Still skip multi-machine fleet, extra providers, service worker, pretty diffs.

### Slice 1 — Make the loop survivable

1. Persist task state (`id`, repo, branch, base SHA, candidate SHA, verification, status). On boot, rehydrate pending approvals and do not delete worktrees that still have a candidate.
2. Register repos explicitly. Drop implicit `cwd` allowlist. `omnidev repo add <path>` / `POST /api/repos`.
3. Token off the query string. Print it once, write `~/.omnidev/token`, accept `Authorization: Bearer` and a short pairing code.
4. Escape repo paths in the dropdown. Voice fills the box; it does not submit.
5. Delete finished tasks from the map. Cap retained failed tasks.

**Done when:** kill the daemon mid-approval, start it again, phone still shows the same candidate SHA and Approve still merges that object.

### Slice 2 — Make the README true

Engine probe / grey-out missing chips. Linux `systemd-inhibit`. License, CI, honest “what this is not.”

### Slice 3 — Tighten, do not widen

Argv arrays for verify commands. Replace the custom runner later. Inject singletons. Bound CORS.

Skip for now: multi-machine fleet, more providers, service worker, pretty diff viewer, thermal ML.

### Slice 3 status (9 Sep 2026)

Landed after `#1`:

- PWA files are an exact basename allowlist (`/`, `/index.html`, `/app.js`, `/manifest.json`). The raw URL path is never `path.join`'d into the filesystem.
- JSON bodies capped at 64KiB (413). WebSocket inbound `maxPayload` is 256KiB. Outbound diffs are unaffected.
- Linux battery/lid via sysfs/ACPI so the backpack interlock can fire on Linux hosts that expose those nodes.
- `commandToArgv` is exported and empty commands are `UNVERIFIED`, not a spawn of `undefined`.
- Tests 23–24 cover static allowlisting, the body cap, and argv-array designated verification.

Still skip: multi-machine fleet, more providers, service worker, pretty diff viewer, thermal ML.

---

## 3. Glossary (Salesforce / FDE framing)

| Term | Meaning in this project |
|---|---|
| **Repo / commit / SHA** | Version-controlled project; immutable snapshot; content-addressed hash of that snapshot. |
| **Worktree** | Git’s scratch org. Same repo, multiple checkouts sharing one object store. |
| **Branch / merge** | Isolated line of development; `--no-ff` forces an explicit integration commit. |
| **Daemon** | Long-running background process behind the API. |
| **PWA** | Web app that can install to the home screen. Phone-side control surface. |
| **API / HTTP / WebSocket** | Request-response vs a push channel for pipeline events. |
| **CORS** | Browser origin policy. `*` disables it. |
| **Token / session cookie** | Bearer credential. Query-string tokens leak via history and Referer. |
| **Allowlist** | Explicit permit list of repo paths the daemon may touch. |
| **innerHTML** | String-concatenated DOM. Unescaped paths become XSS. Bind text. |
| **spawn / execFileSync / argv** | Child-process launch without a shell. Naive space-splitting is not a parser. |
| **Gated execution** | The model proposes; the protocol disposes. Isolate → freeze SHA → verify → approve → merge that SHA. |

---

## 4. Competitive landscape (@iBuild lists)

Orca, Paseo, Emdash, Superset, Zuse, Herdr, T3 Code are cockpits and runtimes around worktrees. They optimize for throughput.

OmniDev optimized for the **merge gate**: freeze a candidate SHA, designated tests, refuse stale approval, refuse destination-HEAD drift, explicit unverified ack, kill the process group before deleting the worktree.

Wedge:

> A local policy and merge engine for coding agents. Any harness can write in a worktree. Only an approved candidate SHA gets onto `main`, and only after designated verification.

Steal Herdr’s persistence, Paseo/T3 pairing, Zuse’s handoff later. Do not out-Orca Orca.

---

## 5. Implementation note

Slice 1 of this plan is implemented in this repository: persisted pending approvals, explicit repo registry, pairing/Bearer auth (no `?token=`), escaped repo dropdown, voice-fills-only, finished-task cleanup, Linux keep-awake, MIT license, and CI.

Slice 3 hygiene (PWA basename allowlist, payload caps, Linux sysfs power/lid, argv-array verifier tests) is documented in [portfolio-overlaps.md](./portfolio-overlaps.md) for cross-repo reuse opportunities. Nothing was extracted into a shared package.
