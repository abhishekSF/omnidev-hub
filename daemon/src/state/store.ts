import fs from 'node:fs';
import path from 'node:path';

export const MAX_RETAINED_FAILED = 20;

export type PersistedStatus =
  | 'STARTING'
  | 'PLANNING'
  | 'EXECUTING'
  | 'REFLECTING'
  | 'AWAITING_APPROVAL'
  | 'MERGED'
  | 'ROLLED_BACK'
  | 'FAILED';

export interface PersistedWorktree {
  taskId: string;
  repoPath: string;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  candidateCommit?: string;
  createdAt: string;
}

export interface PersistedTask {
  id: string;
  canonicalRepo: string;
  status: PersistedStatus;
  candidateCommit?: string;
  diff?: string;
  plan?: string;
  verification?: Record<string, unknown>;
  worktree: PersistedWorktree | null;
}

export interface PersistedState {
  version: 1;
  updatedAt: string;
  tasks: PersistedTask[];
}

export class TaskStateStore {
  constructor(private readonly filePath: string) {}

  public get file(): string {
    return this.filePath;
  }

  public load(): PersistedTask[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as PersistedState;
      if (!raw || raw.version !== 1 || !Array.isArray(raw.tasks)) return [];
      return raw.tasks;
    } catch {
      return [];
    }
  }

  public save(tasks: PersistedTask[]): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload: PersistedState = {
      version: 1,
      updatedAt: new Date().toISOString(),
      tasks: pruneFailedTasks(tasks)
    };
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }
}

export function pruneFailedTasks(tasks: PersistedTask[]): PersistedTask[] {
  const failed = tasks.filter((t) => t.status === 'FAILED');
  if (failed.length <= MAX_RETAINED_FAILED) return tasks;
  const keep = new Set(failed.slice(-MAX_RETAINED_FAILED).map((t) => t.id));
  return tasks.filter((t) => t.status !== 'FAILED' || keep.has(t.id));
}
