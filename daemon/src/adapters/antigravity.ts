import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { terminateChildProcess } from './process-killer.js';

export interface AGYExecutionOptions {
  prompt: string;
  cwd: string;
  role?: string;
}

export class AntiGravityAdapter extends EventEmitter {
  private child: ChildProcess | null = null;
  private lineBuffer = '';

  public async execute(options: AGYExecutionOptions): Promise<void> {
    const args: string[] = ['--prompt', options.prompt];

    this.child = spawn('agy', args, {
      cwd: options.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    });

    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.lineBuffer += chunk.toString();
      const lines = this.lineBuffer.split('\n');
      this.lineBuffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim().length === 0) continue;
        try {
          const parsed = JSON.parse(line);
          this.emit('event', { type: 'step', data: parsed });
        } catch {
          this.emit('event', { type: 'stdout', data: line });
        }
      }
    });

    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.emit('event', { type: 'stderr', data: chunk.toString() });
    });

    this.child.on('error', (err) => {
      this.emit('event', {
        type: 'error',
        data: `Anti-Gravity CLI ('agy') error: ${err.message}`
      });
    });

    this.child.on('close', (code) => {
      this.emit('event', { type: 'done', data: { exitCode: code ?? 1 } });
    });
  }

  public async abort(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      await terminateChildProcess(child, 500, 2000);
    } finally {
      this.child = null;
    }
  }
}
