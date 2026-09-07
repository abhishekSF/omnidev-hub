import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PrivacyPolicyEngine } from '../compiler/policy.js';
import { terminateChildProcess } from './process-killer.js';

export interface OpenCodeExecutionOptions {
  prompt: string;
  cwd: string;
  engineId?: 'opencode' | 'freebuff' | 'ollama-local';
}

export class OpenCodeAdapter extends EventEmitter {
  private child: ChildProcess | null = null;
  private lineBuffer = '';

  public async execute(options: OpenCodeExecutionOptions): Promise<void> {
    const engineId = options.engineId || 'opencode';

    // PRIVACY ENFORCEMENT: Assert that dispatch is permitted for this repo
    PrivacyPolicyEngine.assertDispatchAllowed(options.cwd, engineId);

    const binary = engineId === 'freebuff' ? 'freebuff' : (engineId === 'ollama-local' ? 'ollama' : 'opencode');

    this.child = spawn(binary, ['run', options.prompt], {
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
        this.emit('event', { type: 'stdout', data: line });
      }
    });

    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.emit('event', { type: 'stderr', data: chunk.toString() });
    });

    this.child.on('error', (err) => {
      this.emit('event', {
        type: 'error',
        data: `Engine '${engineId}' execution error: ${err.message}`
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
