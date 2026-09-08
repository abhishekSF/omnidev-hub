import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface IsolatedWorktree {
  taskId: string;
  repoPath: string; // Canonical path
  worktreePath: string;
  branchName: string;
  baseBranch: string; // Expected destination branch in main repo
  baseCommit: string; // Base commit before task
  candidateCommit?: string; // Frozen commit hash
  createdAt: Date;
}

export class DestinationAdvancedException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DestinationAdvancedException';
  }
}

export class WorktreeManager {
  private static worktreesDir(repoPath: string): string {
    const resolvedRepo = fs.realpathSync(path.resolve(repoPath));
    const dir = path.join(resolvedRepo, '.omnidev', 'worktrees');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Ensure .omnidev is silently ignored in git's private exclude file
    const gitDir = path.join(resolvedRepo, '.git');
    if (fs.existsSync(gitDir)) {
      const excludeFile = path.join(gitDir, 'info', 'exclude');
      try {
        if (fs.existsSync(excludeFile)) {
          const content = fs.readFileSync(excludeFile, 'utf8');
          if (!content.includes('.omnidev')) {
            fs.appendFileSync(excludeFile, '\n.omnidev\n.omnidev/**\n');
          }
        }
      } catch {
        // Ignored
      }
    }

    return dir;
  }

  public static createWorktree(rawRepoPath: string, taskId: string): IsolatedWorktree {
    if (!fs.existsSync(rawRepoPath)) {
      throw new Error(`[WorktreeManager] Repository directory does not exist: "${rawRepoPath}"`);
    }

    const repoPath = fs.realpathSync(path.resolve(rawRepoPath));

    // Strict validation of taskId: alphanumeric, dash, underscore only. No shell characters!
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(taskId)) {
      throw new Error(`[WorktreeManager] Invalid taskId: "${taskId}". Must match /^[a-zA-Z0-9_-]{1,64}$/`);
    }

    if (!fs.existsSync(path.join(repoPath, '.git'))) {
      throw new Error(`[WorktreeManager] Directory "${repoPath}" is not a Git repository.`);
    }

    // Capture base commit and current branch of target repository
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8'
    }).trim();

    const baseBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: repoPath,
      encoding: 'utf8'
    }).trim();

    if (!baseBranch) {
      throw new Error(`[WorktreeManager] Repository "${repoPath}" is in a detached HEAD state. Must be on a named branch.`);
    }

    const branchName = `omnidev/${taskId}`;
    const worktreePath = path.join(this.worktreesDir(repoPath), taskId);

    // Clean up if an old worktree exists at that path
    if (fs.existsSync(worktreePath)) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
          cwd: repoPath,
          stdio: 'ignore'
        });
      } catch {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
    }

    // Clean up old branch if it exists
    try {
      execFileSync('git', ['branch', '-D', branchName], {
        cwd: repoPath,
        stdio: 'ignore'
      });
    } catch {
      // Ignored if branch does not exist
    }

    // Create new branch and isolated worktree using execFileSync (NO SHELL INTERPOLATION)
    try {
      execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], {
        cwd: repoPath,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err: any) {
      throw new Error(`[WorktreeManager] Failed to create git worktree: ${err.message}`);
    }

    return {
      taskId,
      repoPath,
      worktreePath,
      branchName,
      baseBranch,
      baseCommit,
      createdAt: new Date()
    };
  }

  /**
   * Freezes candidate state before generating review diff:
   * 1. Stages all uncommitted changes (tracked AND untracked files).
   * 2. Creates candidate commit in worktree branch.
   * 3. Computes complete diff against baseCommit.
   * 4. Binds candidateCommit hash to worktree.
   */
  public static freezeCandidate(worktree: IsolatedWorktree): { candidateCommit: string; diff: string } {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktree.worktreePath,
      encoding: 'utf8'
    }).trim();

    if (status.length > 0) {
      // Stage all files including untracked
      execFileSync('git', ['add', '-A'], {
        cwd: worktree.worktreePath,
        stdio: 'ignore'
      });

      // Commit candidate using argument array
      execFileSync('git', [
        'commit',
        '-m', `omnidev: candidate for task ${worktree.taskId}`,
        '--no-verify'
      ], {
        cwd: worktree.worktreePath,
        stdio: 'ignore'
      });
    }

    const candidateCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktree.worktreePath,
      encoding: 'utf8'
    }).trim();

    worktree.candidateCommit = candidateCommit;

    // Diff baseCommit..candidateCommit captures ALL changes (new files, edits, agent commits)
    const diff = execFileSync('git', ['diff', worktree.baseCommit, candidateCommit], {
      cwd: worktree.worktreePath,
      encoding: 'utf8'
    });

    return { candidateCommit, diff };
  }

  /**
   * Merges EXACT approved commit object into the recorded destination branch.
   * Enforces:
   * 1. Approved commit must match candidateCommit.
   * 2. Worktree HEAD must match approvedCandidateCommit (rejects branch advancement).
   * 3. Main repo must still be on the recorded baseBranch (rejects branch switching).
   * 4. Main repo working tree must be clean.
   * 5. Merges approvedCandidateCommit (exact object), NOT branchName.
   * 6. On merge conflict, target repo is cleanly aborted and worktree is RETAINED.
   */
  public static applyAndMerge(worktree: IsolatedWorktree, approvedCandidateCommit: string): void {
    if (!worktree.candidateCommit) {
      throw new Error(`[WorktreeManager] Cannot merge task "${worktree.taskId}": candidate was never frozen for review.`);
    }

    // Check 1: Approval hash must match frozen candidate
    if (worktree.candidateCommit !== approvedCandidateCommit) {
      throw new Error(
        `[WorktreeManager] Stale approval rejected: candidate commit "${approvedCandidateCommit}" ` +
        `does not match frozen candidate "${worktree.candidateCommit}".`
      );
    }

    // Check 2: Branch advancement rejection: worktree HEAD must equal approved candidate commit
    const currentWorktreeHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktree.worktreePath,
      encoding: 'utf8'
    }).trim();

    if (currentWorktreeHead !== approvedCandidateCommit) {
      throw new Error(
        `[WorktreeManager] Worktree branch advancement detected! Head is now at "${currentWorktreeHead}", ` +
        `which differs from approved candidate "${approvedCandidateCommit}". Unreviewed edits were committed after freeze.`
      );
    }

    // Check 3: Destination branch identity check: main repo must still be on worktree.baseBranch
    const currentRepoBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: worktree.repoPath,
      encoding: 'utf8'
    }).trim();

    if (currentRepoBranch !== worktree.baseBranch) {
      throw new Error(
        `[WorktreeManager] Destination branch mismatch! Main repo has switched to "${currentRepoBranch}", ` +
        `but task was prepared for "${worktree.baseBranch}". Merge rejected to prevent cross-branch pollution.`
      );
    }

    // Check 4: Destination HEAD identity check: main repo HEAD must still match baseCommit
    const currentRepoHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktree.repoPath,
      encoding: 'utf8'
    }).trim();

    if (currentRepoHead !== worktree.baseCommit) {
      throw new DestinationAdvancedException(
        `[WorktreeManager] Destination branch "${worktree.baseBranch}" HEAD has advanced! ` +
        `Current HEAD is "${currentRepoHead}", but task was verified against "${worktree.baseCommit}". ` +
        `Merge rejected: destination integration state has changed and is unverified.`
      );
    }

    // Check 5: Destination working copy must be clean
    const mainRepoStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktree.repoPath,
      encoding: 'utf8'
    }).trim();

    if (mainRepoStatus.length > 0) {
      throw new Error(
        `[WorktreeManager] Destination repository has uncommitted local edits. Merge rejected to prevent dirty tree corruption.`
      );
    }

    // Check 6: Worktree working copy must be clean (no uncommitted edits on top of candidateCommit)
    const worktreeStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktree.worktreePath,
      encoding: 'utf8'
    }).trim();

    if (worktreeStatus.length > 0) {
      throw new Error(
        `[WorktreeManager] Worktree contains uncommitted local edits after candidate freeze. Merge rejected.`
      );
    }

    if (worktree.baseCommit === worktree.candidateCommit) {
      // Clean worktree with no changes, safe cleanup
      this.cleanupWorktree(worktree);
      return;
    }

    try {
      // Merge the EXACT commit object (approvedCandidateCommit), NOT worktree.branchName!
      execFileSync('git', [
        'merge',
        '--no-ff',
        approvedCandidateCommit,
        '-m', `omnidev: merge task ${worktree.taskId} (${approvedCandidateCommit.slice(0, 7)})`
      ], {
        cwd: worktree.repoPath,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err: any) {
      // MERGE FAILED: Cleanly abort destination repo back to HEAD, retain worktree for manual recovery
      try {
        execFileSync('git', ['merge', '--abort'], { cwd: worktree.repoPath, stdio: 'ignore' });
      } catch {
        // Ignored
      }
      throw new Error(
        `[WorktreeManager] Merge failed with conflicts. Target repo was aborted back to clean state. ` +
        `Worktree retained at "${worktree.worktreePath}" for manual recovery. Error: ${err.message}`
      );
    }

    // Merge succeeded: clean up worktree
    this.cleanupWorktree(worktree);
  }

  public static cleanupWorktree(worktree: IsolatedWorktree): void {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktree.worktreePath], {
        cwd: worktree.repoPath,
        stdio: 'ignore'
      });
    } catch {
      if (fs.existsSync(worktree.worktreePath)) {
        fs.rmSync(worktree.worktreePath, { recursive: true, force: true });
      }
    }

    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: worktree.repoPath, stdio: 'ignore' });
      execFileSync('git', ['branch', '-D', worktree.branchName], { cwd: worktree.repoPath, stdio: 'ignore' });
    } catch {
      // Ignored
    }
  }

  /**
   * Reattach a persisted worktree after daemon restart.
   * Returns null if the checkout is gone or HEAD no longer matches the frozen candidate.
   */
  public static restoreWorktree(saved: {
    taskId: string;
    repoPath: string;
    worktreePath: string;
    branchName: string;
    baseBranch: string;
    baseCommit: string;
    candidateCommit?: string;
    createdAt: string | Date;
  }): IsolatedWorktree | null {
    if (!saved.worktreePath || !fs.existsSync(saved.worktreePath)) {
      return null;
    }
    try {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: saved.worktreePath,
        encoding: 'utf8'
      }).trim();
      if (saved.candidateCommit && head !== saved.candidateCommit) {
        return null;
      }
      return {
        taskId: saved.taskId,
        repoPath: saved.repoPath,
        worktreePath: saved.worktreePath,
        branchName: saved.branchName,
        baseBranch: saved.baseBranch,
        baseCommit: saved.baseCommit,
        candidateCommit: saved.candidateCommit,
        createdAt: saved.createdAt instanceof Date ? saved.createdAt : new Date(saved.createdAt)
      };
    } catch {
      return null;
    }
  }
}
