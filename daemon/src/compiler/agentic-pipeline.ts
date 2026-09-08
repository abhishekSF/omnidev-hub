import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { PrivacyPolicyEngine } from './policy.js';
import { WorktreeManager, IsolatedWorktree } from '../worktree/manager.js';
import { KeepAwakeManager, KeepAwakeLease } from '../fleet/keepawake.js';
import { AntiGravityAdapter } from '../adapters/antigravity.js';
import { CursorCLIAdapter } from '../adapters/cursor.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import { HardwareProfiler } from '../fleet/hardware-profiler.js';
import { isEngineAvailable } from '../adapters/probe.js';
import { MAX_RETAINED_FAILED, PersistedTask, TaskStateStore } from '../state/store.js';

export interface PipelineTaskRequest {
  id: string;
  repoPath: string;
  prompt: string;
  forceEngine?: 'cursor' | 'antigravity' | 'opencode' | 'freebuff' | 'auto';
  autoMergeOnSuccess?: boolean;
}

export type VerificationStatus = 'VERIFIED' | 'FAILED' | 'UNVERIFIED';

export interface VerificationEvidence {
  status: VerificationStatus;
  passed: boolean;
  isDesignatedCheck: boolean;
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  message: string;
  verifiedCommit: string;
  baseCommit: string;
  checkedAt: string;
}

export interface TaskContext {
  id: string;
  canonicalRepo: string;
  worktree: IsolatedWorktree | null;
  lease: KeepAwakeLease | null;
  candidateCommit?: string;
  diff?: string;
  plan?: string;
  verification?: VerificationEvidence;
  status: 'STARTING' | 'PLANNING' | 'EXECUTING' | 'REFLECTING' | 'AWAITING_APPROVAL' | 'MERGED' | 'ROLLED_BACK' | 'FAILED';
  isCancelled: boolean;
  activeProcess?: { abort: () => Promise<void> };
  cancelCurrentStage?: (reason: Error) => void;
}

export interface AdapterFactory {
  createPlanningAdapter: (engine: string) => { execute: (opts: any) => Promise<void>; abort: () => Promise<void>; on: any };
  createCodingAdapter: (engine: string) => { execute: (opts: any) => Promise<void>; abort: () => Promise<void>; on: any };
}

export interface CoordinatorOptions {
  stateFile?: string;
}

export class AgenticPipelineCoordinator extends EventEmitter {
  private tasks: Map<string, TaskContext> = new Map();
  private activeRepos: Set<string> = new Set();
  private adapterFactory: AdapterFactory;
  private readonly useDefaultAdapters: boolean;
  private readonly store: TaskStateStore | null;

  constructor(customFactory?: AdapterFactory, options: CoordinatorOptions = {}) {
    super();
    this.useDefaultAdapters = !customFactory;
    this.adapterFactory = customFactory || {
      createPlanningAdapter: () => new AntiGravityAdapter(),
      createCodingAdapter: (engine) => {
        if (engine === 'opencode' || engine === 'freebuff') {
          return new OpenCodeAdapter();
        }
        return new CursorCLIAdapter();
      }
    };
    this.store = options.stateFile ? new TaskStateStore(options.stateFile) : null;
    if (this.store) {
      this.hydrate();
    }
  }

  public getTask(taskId: string): TaskContext | undefined {
    return this.tasks.get(taskId);
  }

  public getActiveTasks(): TaskContext[] {
    return Array.from(this.tasks.values());
  }

  public getPendingApprovals(): { taskId: string; branch: string; candidateCommit: string; diff: string; verification?: VerificationEvidence }[] {
    const list: { taskId: string; branch: string; candidateCommit: string; diff: string; verification?: VerificationEvidence }[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === 'AWAITING_APPROVAL' && task.worktree && task.candidateCommit) {
        list.push({
          taskId: task.id,
          branch: task.worktree.branchName,
          candidateCommit: task.candidateCommit,
          diff: task.diff || '',
          verification: task.verification
        });
      }
    }
    return list;
  }

  public async runPipeline(request: PipelineTaskRequest): Promise<void> {
    // 1. Task ID validation
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(request.id)) {
      const err = `Invalid taskId: "${request.id}". Must match /^[a-zA-Z0-9_-]{1,64}$/`;
      this.emit('error', { taskId: request.id, error: err });
      return;
    }

    if (this.tasks.has(request.id)) {
      const err = `Task ID "${request.id}" is already active. Duplicate task submission rejected.`;
      this.emit('error', { taskId: request.id, error: err });
      return;
    }

    // 2. Canonicalize repository identity to prevent path alias serialization bypass
    if (!fs.existsSync(request.repoPath)) {
      const err = `Repository path does not exist: "${request.repoPath}"`;
      this.emit('error', { taskId: request.id, error: err });
      return;
    }

    let canonicalRepo: string;
    try {
      canonicalRepo = fs.realpathSync(path.resolve(request.repoPath));
    } catch (err: any) {
      this.emit('error', { taskId: request.id, error: `Failed to canonicalize repository path: ${err.message}` });
      return;
    }

    if (this.activeRepos.has(canonicalRepo)) {
      const err = `Repository "${canonicalRepo}" is busy with an active task. Execution serialized.`;
      this.emit('error', { taskId: request.id, error: err });
      return;
    }

    this.activeRepos.add(canonicalRepo);

    const taskCtx: TaskContext = {
      id: request.id,
      canonicalRepo,
      worktree: null,
      lease: null,
      status: 'STARTING',
      isCancelled: false
    };
    this.tasks.set(request.id, taskCtx);

    const hw = HardwareProfiler.getProfile();
    const privacy = PrivacyPolicyEngine.evaluateRepository(canonicalRepo);

    this.emit('log', `[Orchestrator] Starting task ${request.id} for repo ${canonicalRepo}`);
    this.emit('log', `[Hardware] Host: ${hw.hostname} (${hw.computeTier}, Battery: ${hw.powerState.batteryPercent ?? 'AC'}%)`);
    this.emit('log', `[Privacy] Repo level: ${privacy.privacyLevel}. Allowed: [${privacy.allowedEngines.join(', ')}]`);

    // 3. Acquire Keep-Awake lease (with hardware/backpack safety interlock)
    try {
      taskCtx.lease = KeepAwakeManager.acquireLease(request.id, `Agentic pipeline: ${request.prompt}`);
      this.emit('log', `[KeepAwake] Lease acquired: ${taskCtx.lease.id}`);
    } catch (err: any) {
      this.activeRepos.delete(canonicalRepo);
      taskCtx.status = 'FAILED';
      this.emit('error', { taskId: request.id, error: err.message });
      return;
    }

    try {
      // 4. Spawn isolated Git worktree for atomic workspace safety
      this.emit('stage', { taskId: request.id, name: 'WORKTREE_ISOLATION', status: 'RUNNING' });
      taskCtx.worktree = WorktreeManager.createWorktree(canonicalRepo, request.id);
      this.emit('log', `[Worktree] Mounted branch '${taskCtx.worktree.branchName}' at ${taskCtx.worktree.worktreePath}`);
      this.emit('stage', { taskId: request.id, name: 'WORKTREE_ISOLATION', status: 'COMPLETED' });

      if (taskCtx.isCancelled) return;

      // Determine selected engine
      const chosenEngine = (request.forceEngine && request.forceEngine !== 'auto')
        ? request.forceEngine
        : (privacy.privacyLevel === 'STRICT_PRIVATE' ? 'cursor' : 'cursor');

      // Assert privacy policy allows this engine
      PrivacyPolicyEngine.assertDispatchAllowed(canonicalRepo, chosenEngine);

      // 5. Stage 1: PLANNING (Anti-Gravity)
      taskCtx.status = 'PLANNING';
      this.emit('stage', { taskId: request.id, name: 'PLANNING', engine: 'Anti-Gravity', status: 'RUNNING' });
      taskCtx.plan = await this.executePlanning(taskCtx, request, taskCtx.worktree.worktreePath);

      if (taskCtx.isCancelled) return;
      this.emit('stage', { taskId: request.id, name: 'PLANNING', engine: 'Anti-Gravity', status: 'COMPLETED', output: taskCtx.plan });

      // 6. Stage 2: ACT / EXECUTION (Cursor / Chosen Engine)
      taskCtx.status = 'EXECUTING';
      this.emit('stage', { taskId: request.id, name: 'EXECUTION', engine: chosenEngine, status: 'RUNNING' });
      await this.executeCoding(taskCtx, chosenEngine, request, taskCtx.worktree.worktreePath, taskCtx.plan);

      if (taskCtx.isCancelled) return;
      this.emit('stage', { taskId: request.id, name: 'EXECUTION', engine: chosenEngine, status: 'COMPLETED' });

      // 7. Freeze candidate commit FIRST (immutable candidate object)
      const frozen = WorktreeManager.freezeCandidate(taskCtx.worktree);
      taskCtx.candidateCommit = frozen.candidateCommit;
      taskCtx.diff = frozen.diff;

      if (taskCtx.isCancelled) return;

      // 8. Stage 3: REFLECTION ON FROZEN CANDIDATE
      taskCtx.status = 'REFLECTING';
      this.emit('stage', { taskId: request.id, name: 'REFLECTION', engine: 'Verifier', status: 'RUNNING' });
      const verification = await this.executeReflection(
        taskCtx.worktree.worktreePath,
        canonicalRepo,
        taskCtx.worktree.baseCommit,
        frozen.candidateCommit
      );
      taskCtx.verification = verification;

      if (verification.status === 'FAILED') {
        throw new Error(`Reflection verification check failed: ${verification.message}`);
      }

      if (taskCtx.isCancelled) return;
      this.emit('stage', { taskId: request.id, name: 'REFLECTION', engine: 'Verifier', status: 'COMPLETED', output: verification });

      taskCtx.status = 'AWAITING_APPROVAL';
      this.persist();

      this.emit('approval_required', {
        taskId: request.id,
        branch: taskCtx.worktree.branchName,
        baseBranch: taskCtx.worktree.baseBranch,
        candidateCommit: frozen.candidateCommit,
        diff: frozen.diff || '(Clean worktree - no file modifications)',
        plan: taskCtx.plan,
        verification,
        status: 'AWAITING_APPROVAL'
      });

      if (request.autoMergeOnSuccess) {
        if (verification.status !== 'VERIFIED') {
          this.emit('log', `[Orchestrator] Task ${request.id} is UNVERIFIED. Auto-merge suppressed; explicit approval required.`);
        } else {
          this.approveTask(request.id, frozen.candidateCommit);
        }
      }
    } catch (err: any) {
      if (!taskCtx.isCancelled) {
        taskCtx.status = 'FAILED';
        this.emit('error', { taskId: request.id, error: `Pipeline execution failed: ${err.message}` });
        await this.abortTask(request.id);
      }
    }
  }

  public approveTask(taskId: string, candidateCommit: string, options: { allowUnverified?: boolean } = {}): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      const err = `Task "${taskId}" not found.`;
      this.emit('error', { taskId, error: err });
      throw new Error(err);
    }

    if (task.status !== 'AWAITING_APPROVAL' || !task.worktree) {
      const err = `Task "${taskId}" is not in AWAITING_APPROVAL state (current: ${task.status}).`;
      this.emit('error', { taskId, error: err });
      throw new Error(err);
    }

    // Require explicit acknowledgement for UNVERIFIED code
    if (task.verification?.status === 'UNVERIFIED' && !options.allowUnverified) {
      const err = `[WorktreeManager] Approval rejected: Task "${taskId}" has no designated test verification (UNVERIFIED). Merging requires explicit allowUnverified override.`;
      this.emit('error', { taskId, error: err });
      throw new Error(err);
    }

    try {
      this.emit('log', `[Orchestrator] Merging task ${taskId} (commit ${candidateCommit})...`);
      WorktreeManager.applyAndMerge(task.worktree, candidateCommit);
      task.status = 'MERGED';
      this.emit('done', { taskId, status: 'MERGED_SUCCESSFULLY' });
    } catch (err: any) {
      task.status = 'FAILED';
      this.emit('error', { taskId, error: err.message });
      throw err;
    } finally {
      this.finalizeTask(taskId);
    }
  }

  public async abortTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.isCancelled = true;

    // Settle waiting stage promise immediately so runPipeline settles
    if (task.cancelCurrentStage) {
      task.cancelCurrentStage(new Error(`Task ${taskId} cancelled by user abort`));
      task.cancelCurrentStage = undefined;
    }

    // Await child process termination before cleaning worktree or releasing lock
    if (task.activeProcess) {
      try {
        await task.activeProcess.abort();
      } catch (err: any) {
        this.emit('error', {
          taskId,
          error: `Process termination unconfirmed: ${err.message}. Retaining workspace and lock.`
        });
        task.status = 'FAILED';
        this.persist();
        return; // Retain worktree and lock!
      }
      task.activeProcess = undefined;
    }

    if (task.worktree) {
      this.emit('log', `[Orchestrator] Discarding isolated worktree for task ${taskId}...`);
      WorktreeManager.cleanupWorktree(task.worktree);
      task.worktree = null;
    }

    task.status = 'ROLLED_BACK';
    this.emit('done', { taskId, status: 'ROLLED_BACK' });
    this.finalizeTask(taskId);
  }

  private finalizeTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    KeepAwakeManager.releaseLease(taskId);
    this.activeRepos.delete(task.canonicalRepo);

    if (task.status === 'MERGED' || task.status === 'ROLLED_BACK') {
      this.tasks.delete(taskId);
    } else if (task.status === 'FAILED') {
      this.pruneFailedTasks();
    }

    this.persist();
  }

  private persist(): void {
    if (!this.store) return;
    const payload: PersistedTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== 'AWAITING_APPROVAL' && task.status !== 'FAILED') continue;
      payload.push({
        id: task.id,
        canonicalRepo: task.canonicalRepo,
        status: task.status,
        candidateCommit: task.candidateCommit,
        diff: task.diff,
        plan: task.plan,
        verification: task.verification as unknown as Record<string, unknown>,
        worktree: task.worktree
          ? {
              taskId: task.worktree.taskId,
              repoPath: task.worktree.repoPath,
              worktreePath: task.worktree.worktreePath,
              branchName: task.worktree.branchName,
              baseBranch: task.worktree.baseBranch,
              baseCommit: task.worktree.baseCommit,
              candidateCommit: task.worktree.candidateCommit,
              createdAt: task.worktree.createdAt.toISOString()
            }
          : null
      });
    }
    this.store.save(payload);
  }

  private hydrate(): void {
    if (!this.store) return;
    for (const saved of this.store.load()) {
      if (saved.status !== 'AWAITING_APPROVAL' || !saved.worktree || !saved.candidateCommit) {
        continue;
      }
      const worktree = WorktreeManager.restoreWorktree(saved.worktree);
      if (!worktree) {
        continue;
      }
      const taskCtx: TaskContext = {
        id: saved.id,
        canonicalRepo: saved.canonicalRepo,
        worktree,
        lease: null,
        candidateCommit: saved.candidateCommit,
        diff: saved.diff,
        plan: saved.plan,
        verification: saved.verification as unknown as VerificationEvidence | undefined,
        status: 'AWAITING_APPROVAL',
        isCancelled: false
      };
      this.tasks.set(taskCtx.id, taskCtx);
      this.activeRepos.add(taskCtx.canonicalRepo);
      this.emit('log', `[Orchestrator] Restored pending approval ${taskCtx.id} @ ${taskCtx.candidateCommit?.slice(0, 7)}`);
    }
  }

  private pruneFailedTasks(): void {
    const failed = Array.from(this.tasks.values()).filter((t) => t.status === 'FAILED');
    if (failed.length <= MAX_RETAINED_FAILED) return;
    const drop = failed.slice(0, failed.length - MAX_RETAINED_FAILED);
    for (const task of drop) {
      this.tasks.delete(task.id);
    }
  }

  private async executePlanning(taskCtx: TaskContext, request: PipelineTaskRequest, cwd: string): Promise<string> {
    if (this.useDefaultAdapters && !isEngineAvailable('antigravity')) {
      this.emit('log', '[Orchestrator] Anti-Gravity CLI (agy) not found; skipping planning stage.');
      return `Plan: execute task "${request.prompt}"`;
    }

    return new Promise((resolve, reject) => {
      taskCtx.cancelCurrentStage = (err: Error) => reject(err);
      const adapter = this.adapterFactory.createPlanningAdapter('antigravity');
      taskCtx.activeProcess = adapter;
      let capturedPlan = '';
      let hasError = false;

      adapter.on('event', (ev: any) => {
        if (taskCtx.isCancelled) return;

        this.emit('adapter_event', { taskId: request.id, engine: 'Anti-Gravity', ev });
        if (ev.type === 'step' && ev.data?.plan) {
          capturedPlan = ev.data.plan;
        } else if (ev.type === 'stdout' && !capturedPlan) {
          capturedPlan += ev.data + '\n';
        } else if (ev.type === 'error') {
          hasError = true;
          taskCtx.activeProcess = undefined;
          taskCtx.cancelCurrentStage = undefined;
          reject(new Error(`Anti-Gravity planning error: ${ev.data}`));
        } else if (ev.type === 'done') {
          taskCtx.activeProcess = undefined;
          taskCtx.cancelCurrentStage = undefined;
          if (ev.data.exitCode !== 0) {
            reject(new Error(`Anti-Gravity planning exited with non-zero status code: ${ev.data.exitCode}`));
          } else if (!hasError) {
            resolve(capturedPlan.trim() || `Plan: execute task "${request.prompt}"`);
          }
        }
      });

      adapter.execute({ prompt: request.prompt, cwd }).catch((err) => {
        taskCtx.cancelCurrentStage = undefined;
        if (!taskCtx.isCancelled) reject(err);
      });
    });
  }

  private async executeCoding(taskCtx: TaskContext, engine: string, request: PipelineTaskRequest, cwd: string, plan: string): Promise<void> {
    return new Promise((resolve, reject) => {
      taskCtx.cancelCurrentStage = (err: Error) => reject(err);
      const adapter = this.adapterFactory.createCodingAdapter(engine);
      taskCtx.activeProcess = adapter;
      let hasError = false;

      adapter.on('event', (ev: any) => {
        if (taskCtx.isCancelled) return;

        this.emit('adapter_event', { taskId: request.id, engine, ev });
        if (ev.type === 'error') {
          hasError = true;
          taskCtx.activeProcess = undefined;
          taskCtx.cancelCurrentStage = undefined;
          reject(new Error(`${engine} coding error: ${ev.data}`));
        } else if (ev.type === 'done') {
          taskCtx.activeProcess = undefined;
          taskCtx.cancelCurrentStage = undefined;
          if (ev.data.exitCode !== 0) {
            reject(new Error(`${engine} process exited with non-zero status code: ${ev.data.exitCode}`));
          } else if (!hasError) {
            resolve();
          }
        }
      });

      const execOptions: any = {
        prompt: `${request.prompt}\n\nTask Plan:\n${plan}`,
        cwd,
        mode: 'agent',
        allowModifications: true
      };
      if (engine === 'freebuff') {
        execOptions.engineId = 'freebuff';
      } else if (engine === 'opencode') {
        execOptions.engineId = 'opencode';
      }

      adapter.execute(execOptions).catch((err) => {
        taskCtx.cancelCurrentStage = undefined;
        if (!taskCtx.isCancelled) reject(err);
      });
    });
  }

  /**
   * Protects candidate source files by setting them read-only during verification.
   * Returns a function to restore original permissions.
   */
  private protectCandidateFiles(worktreePath: string, candidateCommit: string): () => void {
    let trackedFiles: string[] = [];
    try {
      trackedFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', candidateCommit], {
        cwd: worktreePath,
        encoding: 'utf8'
      }).split('\n').map(s => s.trim()).filter(Boolean);
    } catch {
      return () => {};
    }

    const originalModes: Map<string, number> = new Map();
    for (const relPath of trackedFiles) {
      const fullPath = path.join(worktreePath, relPath);
      try {
        if (fs.existsSync(fullPath)) {
          const stat = fs.statSync(fullPath);
          originalModes.set(fullPath, stat.mode);
          // Make file read-only: remove write bits (0o444 for normal files, 0o555 if executable)
          const readOnlyMode = (stat.mode & 0o111) ? 0o555 : 0o444;
          fs.chmodSync(fullPath, readOnlyMode);
        }
      } catch {
        // Ignored
      }
    }

    return () => {
      for (const [fullPath, mode] of originalModes.entries()) {
        try {
          if (fs.existsSync(fullPath)) {
            fs.chmodSync(fullPath, mode);
          }
        } catch {
          // Ignored
        }
      }
    };
  }

  /**
   * Executes reflection against the frozen candidate:
   * 1. Checks git diff integrity over baseCommit..candidateCommit.
   * 2. Resolves designated verifier from repository config (.omnidev/config.json or package.json test).
   * 3. Protects candidate files read-only during verifier execution.
   * 4. Enforces source immutability: verifies worktree matches candidateCommit before and after.
   * 5. Retains execution evidence: command, stdout, stderr, exit status, duration, and commit hashes.
   */
  private async executeReflection(
    worktreePath: string,
    repoPath: string,
    baseCommit: string,
    candidateCommit: string
  ): Promise<VerificationEvidence> {
    const startTime = Date.now();

    // 1. Verify git diff syntax / formatting across the candidate's changes
    let diffCheckStdout = '';
    let diffCheckStderr = '';
    try {
      diffCheckStdout = execFileSync('git', ['diff', '--check', `${baseCommit}..${candidateCommit}`], {
        cwd: worktreePath,
        encoding: 'utf8'
      });
    } catch (err: any) {
      diffCheckStderr = err.stderr?.toString() || err.stdout?.toString() || err.message;
      return {
        status: 'FAILED',
        passed: false,
        isDesignatedCheck: false,
        message: `Git diff check detected conflict markers or syntax errors in ${baseCommit.slice(0, 7)}..${candidateCommit.slice(0, 7)}: ${diffCheckStderr}`,
        stderr: diffCheckStderr,
        exitCode: err.status ?? 1,
        durationMs: Date.now() - startTime,
        verifiedCommit: candidateCommit,
        baseCommit,
        checkedAt: new Date().toISOString()
      };
    }

    // 2. Resolve designated test command from trusted repository configuration
    let designatedCommand: string | string[] | null = null;
    const configPath = path.join(repoPath, '.omnidev', 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.verification?.command) {
          designatedCommand = config.verification.command;
        }
      } catch {
        // Ignored
      }
    }

    // Auto-detect package.json test script if not explicitly in config
    if (!designatedCommand) {
      const pkgPath = path.join(repoPath, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          if (pkg.scripts?.test && !pkg.scripts.test.includes('no test specified')) {
            designatedCommand = ['npm', 'test'];
          }
        } catch {
          // Ignored
        }
      }
    }

    // If no designated test exists: report UNVERIFIED state
    if (!designatedCommand) {
      return {
        status: 'UNVERIFIED',
        passed: false,
        isDesignatedCheck: false,
        stdout: diffCheckStdout,
        message: 'UNVERIFIED: No designated test command configured in repository settings. Code verification was NOT performed.',
        verifiedCommit: candidateCommit,
        baseCommit,
        durationMs: Date.now() - startTime,
        checkedAt: new Date().toISOString()
      };
    }

    const argv = commandToArgv(designatedCommand);
    const commandLabel = argv.join(' ');

    // 3. Designated command exists: Protect tracked files before running verifier!
    const unprotectFiles = this.protectCandidateFiles(worktreePath, candidateCommit);
    let cmdStdout = '';
    let cmdStderr = '';
    let cmdExitCode = 0;

    try {
      const bin = argv[0];
      const args = argv.slice(1);
      const out = execFileSync(bin, args, {
        cwd: worktreePath,
        timeout: 60000,
        encoding: 'utf8'
      });
      cmdStdout = (out || '').slice(0, 10000);
    } catch (err: any) {
      cmdStdout = (err.stdout?.toString() || '').slice(0, 10000);
      cmdStderr = (err.stderr?.toString() || err.message || '').slice(0, 10000);
      cmdExitCode = err.status ?? 1;
    } finally {
      // Restore file permissions
      unprotectFiles();
    }

    // 4. Source Mutation Detection: verify that working tree was not mutated
    const diffStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf8'
    }).trim();

    const diffAgainstCandidate = execFileSync('git', ['diff', candidateCommit, '--'], {
      cwd: worktreePath,
      encoding: 'utf8'
    }).trim();

    if (diffAgainstCandidate.length > 0 || diffStatus.length > 0) {
      return {
        status: 'FAILED',
        passed: false,
        isDesignatedCheck: true,
        command: commandLabel,
        stdout: cmdStdout,
        stderr: `Source mutation detected during verification: Working copy differs from frozen candidate commit ${candidateCommit}.`,
        exitCode: cmdExitCode !== 0 ? cmdExitCode : 1,
        durationMs: Date.now() - startTime,
        message: `Verification failed: candidate source files were modified during test execution.`,
        verifiedCommit: candidateCommit,
        baseCommit,
        checkedAt: new Date().toISOString()
      };
    }

    if (cmdExitCode !== 0) {
      return {
        status: 'FAILED',
        passed: false,
        isDesignatedCheck: true,
        command: commandLabel,
        stdout: cmdStdout,
        stderr: cmdStderr,
        exitCode: cmdExitCode,
        durationMs: Date.now() - startTime,
        message: `Designated verification "${commandLabel}" failed with exit code ${cmdExitCode}.`,
        verifiedCommit: candidateCommit,
        baseCommit,
        checkedAt: new Date().toISOString()
      };
    }

    return {
      status: 'VERIFIED',
      passed: true,
      isDesignatedCheck: true,
      command: commandLabel,
      stdout: cmdStdout,
      stderr: cmdStderr,
      exitCode: 0,
      durationMs: Date.now() - startTime,
      message: `Designated verification "${commandLabel}" passed cleanly.`,
      verifiedCommit: candidateCommit,
      baseCommit,
      checkedAt: new Date().toISOString()
    };
  }
}

function commandToArgv(command: string | string[]): string[] {
  if (Array.isArray(command)) {
    return command.map((part) => String(part)).filter((s) => s.length > 0);
  }
  return command
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((a) => a.replace(/^["']|["']$/g, ''));
}
