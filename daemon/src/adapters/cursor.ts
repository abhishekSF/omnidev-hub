import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { terminateChildProcess } from './process-killer.js';

export interface CursorExecutionOptions {
  prompt: string;
  cwd: string;
  mode?: 'agent' | 'plan' | 'ask';
  allowModifications?: boolean;
}

export interface CursorEvent {
  type: 'stdout' | 'stderr' | 'diff' | 'step' | 'done' | 'error';
  data: any;
}

export class CursorCLIAdapter extends EventEmitter {
  private child: ChildProcess | null = null;
  private lineBuffer = '';

  public async execute(options: CursorExecutionOptions): Promise<void> {
    const args: string[] = ['-p', options.prompt];

    const mode = options.mode || 'agent';
    args.push(`--mode=${mode}`);

    if (options.allowModifications) {
      args.push('--force');
    }

    args.push('--output-format', 'stream-json');

    this.child = spawn('agent', args, {
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
        data: `Cursor CLI execution error: ${err.message}`
      });
    });

    this.child.on('close', (code) => {
      if (this.lineBuffer.trim().length > 0) {
        try {
          const parsed = JSON.parse(this.lineBuffer);
          this.emit('event', { type: 'step', data: parsed });
        } catch {
          this.emit('event', { type: 'stdout', data: this.lineBuffer });
        }
        this.lineBuffer = '';
      }
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
