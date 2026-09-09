import { spawn, ChildProcess } from 'node:child_process';
import os from 'node:os';
import { HardwareProfiler } from './hardware-profiler.js';

export interface KeepAwakeLease {
  id: string;
  reason: string;
  acquiredAt: Date;
  expiresAt: Date;
  active: boolean;
  timer?: NodeJS.Timeout;
}

export class KeepAwakeManager {
  private static activeLeases: Map<string, KeepAwakeLease> = new Map();
  private static caffeinateProcess: ChildProcess | null = null;

  public static acquireLease(taskId: string, reason: string, maxDurationMinutes = 60): KeepAwakeLease {
    // Validate taskId
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(taskId)) {
      throw new Error(`[KeepAwake] Invalid taskId format: "${taskId}". Must match /^[a-zA-Z0-9_-]{1,64}$/`);
    }

    // Release existing lease if re-acquiring with same ID to clear previous timer
    if (this.activeLeases.has(taskId)) {
      this.releaseLease(taskId);
    }

    const profile = HardwareProfiler.getProfile();

    // HARDWARE SAFETY INTERLOCK: Refuse keep-awake if laptop is closed and running on battery!
    if (profile.safetyFlags.backpackRisk) {
      throw new Error(
        `[SAFETY INTERLOCK REJECTION] Machine is running on battery with the clamshell lid closed. ` +
        `Refusing to activate keep-awake lease to prevent thermal runaway in an enclosed bag.`
      );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + maxDurationMinutes * 60 * 1000);

    const lease: KeepAwakeLease = {
      id: taskId,
      reason,
      acquiredAt: now,
      expiresAt,
      active: true
    };

    // Auto-expiry timer with unref so it does not keep test process alive
    const timer = setTimeout(() => {
      this.releaseLease(taskId);
    }, maxDurationMinutes * 60 * 1000);
    timer.unref();
    lease.timer = timer;

    this.activeLeases.set(taskId, lease);
    this.ensureKeepAwakeRunning();

    return lease;
  }

  public static releaseLease(taskId: string): void {
    const lease = this.activeLeases.get(taskId);
    if (lease) {
      if (lease.timer) {
        clearTimeout(lease.timer);
        lease.timer = undefined;
      }
      lease.active = false;
      this.activeLeases.delete(taskId);
    }

    if (this.activeLeases.size === 0) {
      this.stopKeepAwake();
    }
  }

  public static getActiveLeases(): KeepAwakeLease[] {
    return Array.from(this.activeLeases.values()).map(({ timer, ...rest }) => rest);
  }

  public static releaseAll(): void {
    for (const id of Array.from(this.activeLeases.keys())) {
      this.releaseLease(id);
    }
    this.stopKeepAwake();
  }

  private static ensureKeepAwakeRunning(): void {
    if (this.caffeinateProcess) return;

    const platform = os.platform();
    if (platform === 'darwin') {
      try {
        // -dimsu: prevent display, idle, disk, and system sleep
        this.caffeinateProcess = spawn('caffeinate', ['-dimsu'], {
          stdio: 'ignore',
          detached: false
        });

        this.caffeinateProcess.on('exit', () => {
          this.caffeinateProcess = null;
        });
        this.caffeinateProcess.on('error', () => {
          this.caffeinateProcess = null;
        });
      } catch (err) {
        console.error('[KeepAwake] Failed to launch caffeinate on macOS:', err);
      }
    } else if (platform === 'win32') {
      try {
        // Windows SetThreadExecutionState: ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001) | ES_AWAYMODE_REQUIRED (0x00000040)
        const psScript = `
          $code = @"
          using System;
          using System.Runtime.InteropServices;
          public class WinSleep {
            [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
            public static extern uint SetThreadExecutionState(uint esFlags);
          }
"@
          Add-Type -TypeDefinition $code
          [WinSleep]::SetThreadExecutionState(0x80000041)
          Start-Sleep -Seconds 86400
        `;
        this.caffeinateProcess = spawn('powershell', ['-NoProfile', '-Command', psScript], {
          stdio: 'ignore',
          detached: false
        });
        this.caffeinateProcess.on('error', () => {
          this.caffeinateProcess = null;
        });
      } catch (err) {
        console.error('[KeepAwake] Failed to spawn Windows keep-awake assertion:', err);
      }
    } else if (platform === 'linux') {
      try {
        this.caffeinateProcess = spawn('systemd-inhibit', [
          '--what=idle:sleep',
          '--who=OmniDev Hub',
          '--why=Active agent task',
          '--mode=block',
          'sleep',
          'infinity'
        ], {
          stdio: 'ignore',
          detached: false
        });
        this.caffeinateProcess.on('error', () => {
          this.caffeinateProcess = null;
        });
        this.caffeinateProcess.on('exit', () => {
          this.caffeinateProcess = null;
        });
      } catch (err) {
        console.error('[KeepAwake] systemd-inhibit unavailable; lease is tracked in-process only:', err);
      }
    }
  }

  private static stopKeepAwake(): void {
    if (this.caffeinateProcess) {
      try {
        this.caffeinateProcess.kill('SIGTERM');
      } catch {
        // Ignored
      }
      this.caffeinateProcess = null;
    }
  }
}
