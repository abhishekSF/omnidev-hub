import { ChildProcess } from 'node:child_process';

/**
 * Signals a child process and its process group (if spawned detached).
 */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child || !child.pid) return;
  try {
    // Send signal to process group first (negative PID)
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already terminated
    }
  }
}

/**
 * Robust child process termination:
 * 1. Verifies whether process is already terminated via exitCode / signalCode (NOT child.killed).
 * 2. Sends SIGTERM to process group.
 * 3. Escalates to SIGKILL if still alive after timeoutMs.
 * 4. Awaits confirmed exit / close event.
 * 5. Rejects if process remains alive past deadlineMs, preventing lock release or worktree deletion.
 */
export async function terminateChildProcess(
  child: ChildProcess | null,
  timeoutMs: number = 500,
  deadlineMs: number = 2000
): Promise<void> {
  if (!child || !child.pid) return;

  // Process already exited and reaped
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  return new Promise<void>((resolve, reject) => {
    let finished = false;
    let escalateTimer: NodeJS.Timeout | null = null;
    let deadlineTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (!finished) {
        finished = true;
        if (escalateTimer) clearTimeout(escalateTimer);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        resolve();
      }
    };

    child.once('exit', cleanup);
    child.once('close', cleanup);

    // 1. Send SIGTERM to process group
    killProcessGroup(child, 'SIGTERM');

    // 2. Escalation timer: if still running after timeoutMs, send SIGKILL
    escalateTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        killProcessGroup(child, 'SIGKILL');
      }
    }, timeoutMs);
    escalateTimer.unref();

    // 3. Deadline timer: if STILL not terminated after deadlineMs, reject
    deadlineTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        finished = true;
        reject(
          new Error(
            `[ProcessKiller] Failed to confirm termination of child process PID ${child.pid} within ${deadlineMs}ms.`
          )
        );
      } else {
        cleanup();
      }
    }, deadlineMs);
    deadlineTimer.unref();
  });
}
