# OmniDev Hub

> Multi-Agent Fleet Controller, Privacy Router, and Worktree Execution Orchestrator.

OmniDev Hub is an orchestration layer and mobile-friendly PWA control surface enabling secure, hardware-safe, and privacy-governed coordination across local AI coding agents (Cursor CLI, Anti-Gravity, OpenCode).

## Features

- **Isolated Git Worktrees & Atomic Merging**: Every agent task executes in an isolated Git worktree. Completed work is frozen into an immutable candidate commit before review, and merges are cryptographically bound to exact approved commit SHAs (`git merge --no-ff <approvedCandidateCommit>`).
- **Source Immutability & Verification Gates**: Source files are write-protected read-only during verification (`chmod 0o444`/`0o555`). Post-verification tree status checks ensure tests never pass on mutated code.
- **Explicit UNVERIFIED Handling**: Repositories without designated verification commands are flagged as `UNVERIFIED`. Automated merges are suppressed, and user confirmation is required.
- **Hardware-Aware Power & Keep-Awake Leases**: Automatic platform detection (macOS `caffeinate`, Linux `systemd-inhibit`, Windows) with thermal and battery interlocks preventing battery drain or laptop-in-a-bag overheating.
- **Deterministic Child Process Termination**: Process group signaling (`killProcessGroup`) with automated escalation from SIGTERM to SIGKILL, confirmed exit checks, and lock retention on failure.
- **Repository Allowlisting & Symlink Protection**: Strict `RepositoryRegistry` path canonicalization via `fs.realpathSync()`. Symlinks pointing outside registered roots are blocked.
- **Mobile PWA & WebSocket Streaming**: Real-time event streaming, live telemetry, diff inspection, voice task entry, and candidate approval interface.

## Project Structure

```
omnidev-hub/
├── daemon/               # Node.js TypeScript daemon
│   ├── src/
│   │   ├── adapters/     # Process adapters (cursor, antigravity, opencode, process-killer)
│   │   ├── compiler/     # Agentic pipeline coordinator & privacy policy engine
│   │   ├── fleet/        # Hardware profiler & keep-awake lease manager
│   │   ├── worktree/     # Isolated Git worktree manager & merge controller
│   │   └── server.ts     # Authenticated HTTP and WebSocket server
├── pwa/                  # Mobile-ready web control interface
│   ├── index.html        # Single-page control surface
│   ├── app.js            # WebSocket client, diff viewer, voice input
│   └── manifest.json     # PWA web app manifest
└── tests/                # Hardened 19-suite verification harness
    └── verify-engine.ts  # End-to-end regression tests (68/68 assertions)
```

## Quick Start

### 1. Install Dependencies
```bash
cd daemon
npm install
```

### 2. Run Test Suite
```bash
cd daemon
npm test
```
Runs 19 regression test suites verifying shell sanitization, symlink traversal prevention, candidate freezing, source immutability, process escalation, and unverified approval gating.

### 3. Start Daemon
```bash
cd daemon
OMNIDEV_TOKEN="your-secure-secret-token" HOST="127.0.0.1" npm start
```

Access the PWA client at `http://127.0.0.1:3842?token=your-secure-secret-token`.
