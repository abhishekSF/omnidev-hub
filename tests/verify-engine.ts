import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { HardwareProfiler } from '../daemon/src/fleet/hardware-profiler.js';
import { KeepAwakeManager } from '../daemon/src/fleet/keepawake.js';
import { PrivacyPolicyEngine } from '../daemon/src/compiler/policy.js';
import { WorktreeManager, DestinationAdvancedException } from '../daemon/src/worktree/manager.js';
import { AgenticPipelineCoordinator, AdapterFactory } from '../daemon/src/compiler/agentic-pipeline.js';
import { AntiGravityAdapter } from '../daemon/src/adapters/antigravity.js';
import { terminateChildProcess } from '../daemon/src/adapters/process-killer.js';
import { createOmniDevServer, validateToken, RepositoryRegistry } from '../daemon/src/server.js';
import { EventEmitter } from 'node:events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testBaseDir = path.resolve(__dirname, '../.test-tmp');

// Isolate git from host configuration when running in sandboxed or isolated environments
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

async function runTests() {
  console.log('🧪 Starting OmniDev Hub Hardened Verification Suite...\n');
  let passed = 0;
  let total = 0;

  function assert(condition: boolean, testName: string) {
    total++;
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}`);
      process.exitCode = 1;
    }
  }

  // Ensure clean test scratch directory
  if (fs.existsSync(testBaseDir)) {
    fs.rmSync(testBaseDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testBaseDir, { recursive: true });

  // --- TEST 1: Task ID Sanitization & Shell Metacharacter Rejection ---
  console.log('1. Testing Task ID Sanitization & Shell Metacharacter Rejection...');
  const maliciousIds = [
    'task;touch pwned',
    'task$(touch pwned)',
    'task`touch pwned`',
    'task|echo pwned',
    'task/../../etc/passwd',
    'task with spaces'
  ];

  for (const badId of maliciousIds) {
    let worktreeRejected = false;
    try {
      WorktreeManager.createWorktree(testBaseDir, badId);
    } catch {
      worktreeRejected = true;
    }
    assert(worktreeRejected, `Rejected shell-injection task ID in WorktreeManager: "${badId}"`);

    let keepAwakeRejected = false;
    try {
      KeepAwakeManager.acquireLease(badId, 'test');
    } catch {
      keepAwakeRejected = true;
    }
    assert(keepAwakeRejected, `Rejected shell-injection task ID in KeepAwakeManager: "${badId}"`);
  }

  assert(!fs.existsSync(path.join(testBaseDir, 'pwned')), 'No injected shell commands were executed');

  // --- TEST 2: Hardware Profiler & Clean Timer Release ---
  console.log('\n2. Testing Hardware Profiler & Clean Timer Release...');
  const profile = HardwareProfiler.getProfile();
  assert(typeof profile.hostname === 'string' && profile.hostname.length > 0, 'Hostname identified');
  assert(profile.cpuCores > 0, `CPU cores detected: ${profile.cpuCores} cores`);

  const testTaskId = `valid_task_${Date.now()}`;
  const lease = KeepAwakeManager.acquireLease(testTaskId, 'Testing timer cleanup', 10);
  assert(lease.active && lease.timer !== undefined, 'Lease created with clearable unref timer');
  KeepAwakeManager.releaseLease(testTaskId);
  assert(!KeepAwakeManager.getActiveLeases().some(l => l.id === testTaskId), 'Lease released and cleared');

  // --- TEST 3: Privacy Fencing: Default-Deny & Secret Override ---
  console.log('\n3. Testing Privacy Fencing: Default-Deny & Secret Override...');
  const privRepo = path.join(testBaseDir, 'priv_repo');
  fs.mkdirSync(privRepo, { recursive: true });
  fs.writeFileSync(path.join(privRepo, '.env'), 'API_SECRET=supersecret');

  const omniDir = path.join(privRepo, '.omnidev');
  fs.mkdirSync(omniDir, { recursive: true });
  fs.writeFileSync(path.join(omniDir, 'config.json'), JSON.stringify({ privacy: 'PUBLIC_SCRATCH' }));

  const privReport = PrivacyPolicyEngine.evaluateRepository(privRepo);
  assert(privReport.privacyLevel === 'STRICT_PRIVATE', 'Secret files override PUBLIC_SCRATCH config; forced to STRICT_PRIVATE');
  assert(!privReport.allowedEngines.includes('opencode'), 'OpenCode excluded from allowed engines on private repo');

  let opencodeBlocked = false;
  try {
    PrivacyPolicyEngine.assertDispatchAllowed(privRepo, 'opencode');
  } catch {
    opencodeBlocked = true;
  }
  assert(opencodeBlocked, 'Blocked opencode dispatch on private repository');

  let unknownBlocked = false;
  try {
    PrivacyPolicyEngine.assertDispatchAllowed(privRepo, 'unknown-model-provider');
  } catch {
    unknownBlocked = true;
  }
  assert(unknownBlocked, 'Default-deny blocked unrecognized provider identifier');

  // --- TEST 4: Truthful Adapter Failure When Binaries Are Missing ---
  console.log('\n4. Testing Truthful Adapter Failure When Binaries Are Missing...');
  const agyAdapter = new AntiGravityAdapter();
  let agyFailedTruthfully = false;

  await new Promise<void>((resolve) => {
    agyAdapter.on('event', (ev) => {
      if (ev.type === 'error' || (ev.type === 'done' && ev.data?.exitCode !== 0)) {
        agyFailedTruthfully = true;
      }
      if (ev.type === 'done') {
        resolve();
      }
    });
    agyAdapter.execute({ prompt: 'test', cwd: testBaseDir }).catch(() => {
      agyFailedTruthfully = true;
      resolve();
    });
  });
  assert(agyFailedTruthfully, "AntiGravityAdapter truthfully reports error/exitCode when 'agy' fails to spawn (no mock success)");

  // --- TEST 5: Complete Candidate Freeze (Untracked Files Captured) ---
  console.log('\n5. Testing Complete Candidate Freeze (Untracked Files Captured)...');
  const gitRepo = path.join(testBaseDir, 'git_repo');
  fs.mkdirSync(gitRepo, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: gitRepo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitRepo });
  execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: gitRepo });
  fs.writeFileSync(path.join(gitRepo, 'base.txt'), 'base content\n');
  execFileSync('git', ['add', 'base.txt'], { cwd: gitRepo });
  execFileSync('git', ['commit', '-m', 'base commit'], { cwd: gitRepo });

  const worktreeTaskId = `task_candidate_${Date.now()}`;
  const worktree = WorktreeManager.createWorktree(gitRepo, worktreeTaskId);

  // Add a brand new UNTRACKED file inside worktree
  fs.writeFileSync(path.join(worktree.worktreePath, 'brand_new_untracked.txt'), 'new file content\n');

  // Freeze candidate
  const frozen = WorktreeManager.freezeCandidate(worktree);
  assert(frozen.candidateCommit.length > 0, `Candidate frozen at commit: ${frozen.candidateCommit.slice(0, 7)}`);
  assert(frozen.diff.includes('brand_new_untracked.txt'), 'Untracked new file is captured in the review diff');

  // --- TEST 6: Branch Advancement Rejection ---
  console.log('\n6. Testing Branch Advancement Rejection (Post-Freeze Edits Blocked)...');
  // Commit additional content on worktree branch AFTER freezing candidate
  fs.writeFileSync(path.join(worktree.worktreePath, 'post_freeze_edit.txt'), 'unreviewed content\n');
  execFileSync('git', ['add', 'post_freeze_edit.txt'], { cwd: worktree.worktreePath });
  execFileSync('git', ['commit', '-m', 'unreviewed post-freeze edit'], { cwd: worktree.worktreePath });

  let branchAdvancementRejected = false;
  try {
    WorktreeManager.applyAndMerge(worktree, frozen.candidateCommit);
  } catch (err: any) {
    if (err.message.includes('Worktree branch advancement detected')) {
      branchAdvancementRejected = true;
    }
  }
  assert(branchAdvancementRejected, 'Rejected merge because worktree branch advanced after candidate was frozen');

  // Reset worktree back to frozen candidate commit for further tests
  execFileSync('git', ['reset', '--hard', frozen.candidateCommit], { cwd: worktree.worktreePath });

  // --- TEST 7: Destination Branch Switching Rejection ---
  console.log('\n7. Testing Destination Branch Switching Rejection...');
  // Switch main repo to a different branch
  execFileSync('git', ['checkout', '-b', 'other_branch'], { cwd: gitRepo });

  let branchSwitchRejected = false;
  try {
    WorktreeManager.applyAndMerge(worktree, frozen.candidateCommit);
  } catch (err: any) {
    if (err.message.includes('Destination branch mismatch')) {
      branchSwitchRejected = true;
    }
  }
  assert(branchSwitchRejected, 'Rejected merge because main repo switched branches away from target destination');

  // Switch main repo back to original destination branch
  execFileSync('git', ['checkout', 'main'], { cwd: gitRepo });

  // --- TEST 8: Stale / Mismatched Approval Rejection ---
  console.log('\n8. Testing Stale Approval Rejection...');
  let staleApprovalRejected = false;
  try {
    WorktreeManager.applyAndMerge(worktree, '0000000000000000000000000000000000000000');
  } catch {
    staleApprovalRejected = true;
  }
  assert(staleApprovalRejected, 'Rejected approval with mismatched candidateCommit hash');

  // --- TEST 9: Merge Conflict Handling & Worktree Retention ---
  console.log('\n9. Testing Merge Conflict Handling & Worktree Retention...');
  fs.writeFileSync(path.join(worktree.worktreePath, 'base.txt'), 'worktree edit\n');
  const frozenConflict = WorktreeManager.freezeCandidate(worktree);

  // Create conflict in main repo
  fs.writeFileSync(path.join(gitRepo, 'base.txt'), 'conflicting main edit\n');
  execFileSync('git', ['commit', '-am', 'conflicting commit in main'], { cwd: gitRepo });
  worktree.baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitRepo, encoding: 'utf8' }).trim();

  let mergeConflictCaught = false;
  try {
    WorktreeManager.applyAndMerge(worktree, frozenConflict.candidateCommit);
  } catch (err: any) {
    mergeConflictCaught = true;
    assert(err.message.includes('Merge failed with conflicts'), 'Threw explicit MergeConflictException');
  }
  assert(mergeConflictCaught, 'Merge conflict was safely intercepted');

  const statusInMain = execFileSync('git', ['status', '--porcelain'], { cwd: gitRepo, encoding: 'utf8' });
  assert(statusInMain.trim().length === 0, 'Target repo aborted cleanly back to clean HEAD');
  assert(fs.existsSync(worktree.worktreePath), 'Isolated worktree was retained on disk for user recovery');

  WorktreeManager.cleanupWorktree(worktree);

  // --- TEST 10: Designated Reflection Verification ---
  console.log('\n10. Testing Designated Reflection Verification on Frozen Candidate...');
  const repoForReflection = path.join(testBaseDir, 'repo_reflection');
  fs.mkdirSync(repoForReflection, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoForReflection });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoForReflection });
  execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: repoForReflection });
  fs.writeFileSync(path.join(repoForReflection, 'index.js'), 'console.log("ok");\n');
  execFileSync('git', ['add', 'index.js'], { cwd: repoForReflection });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoForReflection });

  // Add .omnidev/config.json with a designated verification command that fails
  const omniReflectDir = path.join(repoForReflection, '.omnidev');
  fs.mkdirSync(omniReflectDir, { recursive: true });
  fs.writeFileSync(path.join(omniReflectDir, 'config.json'), JSON.stringify({
    verification: { command: 'node -e process.exit(1)' }
  }));

  const fakeFactory: AdapterFactory = {
    createPlanningAdapter: () => {
      const emitter = new EventEmitter() as any;
      emitter.execute = async () => {
        setTimeout(() => {
          emitter.emit('event', { type: 'step', data: { plan: 'Plan' } });
          emitter.emit('event', { type: 'done', data: { exitCode: 0 } });
        }, 10);
      };
      emitter.abort = async () => {};
      return emitter;
    },
    createCodingAdapter: () => {
      const emitter = new EventEmitter() as any;
      emitter.execute = async () => {
        setTimeout(() => {
          emitter.emit('event', { type: 'done', data: { exitCode: 0 } });
        }, 10);
      };
      emitter.abort = async () => {};
      return emitter;
    }
  };

  const coordinatorFailing = new AgenticPipelineCoordinator(fakeFactory);
  let reflectionBlocked = false;

  await new Promise<void>((resolve) => {
    coordinatorFailing.on('error', (err) => {
      if (err.error && err.error.includes('Reflection verification check failed')) {
        reflectionBlocked = true;
      }
      resolve();
    });

    coordinatorFailing.runPipeline({
      id: `task_reflect_fail_${Date.now()}`,
      repoPath: repoForReflection,
      prompt: 'Task expecting designated test'
    });
  });
  assert(reflectionBlocked, 'Designated failing repository check halted pipeline before approval stage');

  // --- TEST 11: Path Alias Serialization (Trailing Slash & Symlinks) ---
  console.log('\n11. Testing Path Alias Serialization (Trailing Slash & Realpath)...');
  const coordinatorAlias = new AgenticPipelineCoordinator(fakeFactory);
  const aliasRepo = path.join(testBaseDir, 'alias_repo');
  fs.mkdirSync(aliasRepo, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: aliasRepo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: aliasRepo });
  execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: aliasRepo });
  fs.writeFileSync(path.join(aliasRepo, 'f.txt'), 'data\n');
  execFileSync('git', ['add', 'f.txt'], { cwd: aliasRepo });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: aliasRepo });

  let aliasRejected = false;
  const taskA = `task_alias_a_${Date.now()}`;
  const taskB = `task_alias_b_${Date.now()}`;

  // Start task on canonical path
  coordinatorAlias.runPipeline({
    id: taskA,
    repoPath: aliasRepo,
    prompt: 'task a'
  });

  coordinatorAlias.on('error', (err) => {
    if (err.taskId === taskB && err.error.includes('busy with an active task')) {
      aliasRejected = true;
    }
  });

  // Attempt second task with trailing slash alias on same repo
  await coordinatorAlias.runPipeline({
    id: taskB,
    repoPath: aliasRepo + path.sep,
    prompt: 'task b'
  });

  assert(aliasRejected, 'Path alias with trailing slash was recognized as same repo and serialized');
  await coordinatorAlias.abortTask(taskA);

  // --- TEST 12: Cancellation Lifecycle & Late Event Suppression ---
  console.log('\n12. Testing Cancellation Lifecycle (Late Completion Suppressed)...');
  let planningEmitter: any;
  let codingStartedAfterCancel = false;

  const cancelFactory: AdapterFactory = {
    createPlanningAdapter: () => {
      planningEmitter = new EventEmitter() as any;
      planningEmitter.execute = async () => {}; // Never auto-completes until manual event
      planningEmitter.abort = async () => {};
      return planningEmitter;
    },
    createCodingAdapter: () => {
      const emitter = new EventEmitter() as any;
      emitter.execute = async () => {
        codingStartedAfterCancel = true;
      };
      emitter.abort = async () => {};
      return emitter;
    }
  };

  const coordinatorCancel = new AgenticPipelineCoordinator(cancelFactory);
  const cancelTaskId = `task_cancel_${Date.now()}`;

  coordinatorCancel.runPipeline({
    id: cancelTaskId,
    repoPath: aliasRepo,
    prompt: 'cancel task'
  });

  // Abort while in planning
  await coordinatorCancel.abortTask(cancelTaskId);

  // Emit late planning completion event
  planningEmitter.emit('event', { type: 'step', data: { plan: 'Late Plan' } });
  planningEmitter.emit('event', { type: 'done', data: { exitCode: 0 } });

  // Wait 50ms to ensure coding stage is NOT triggered
  await new Promise(r => setTimeout(r, 50));
  assert(!codingStartedAfterCancel, 'Cancellation prevented late planning event from starting coding stage');

  // --- TEST 13: Token Validation Safety (timingSafeEqual Crash Prevention) ---
  console.log('\n13. Testing Token Validation Safety (Lengths, Malformed & Multi-byte)...');
  const testSecret = 'secret_test_token_12345';
  assert(validateToken(testSecret, testSecret) === true, 'Matching token returns true');
  assert(validateToken('x', testSecret) === false, 'Short token returns false without crashing (no length throw)');
  assert(validateToken('x'.repeat(100), testSecret) === false, 'Long token returns false without crashing');
  assert(validateToken('', testSecret) === false, 'Empty token returns false');
  assert(validateToken(null, testSecret) === false, 'Null token returns false');
  assert(validateToken(undefined, testSecret) === false, 'Undefined token returns false');
  assert(validateToken('🔑🔑🔑', testSecret) === false, 'Multi-byte UTF-8 token returns false without throwing');

  // --- TEST 14: Symlink Traversal Protection in RepositoryRegistry ---
  console.log('\n14. Testing Symlink Traversal Protection in RepositoryRegistry...');
  const outsideDir = path.join(testBaseDir, 'outside_unapproved_dir');
  fs.mkdirSync(outsideDir, { recursive: true });

  const insideRoot = path.join(testBaseDir, 'allowed_root');
  fs.mkdirSync(insideRoot, { recursive: true });
  RepositoryRegistry.setAllowedRoots([insideRoot]);

  // Create symlink inside allowedRoot pointing to outside directory
  const symlinkPath = path.join(insideRoot, 'symlink_to_outside');
  try {
    fs.symlinkSync(outsideDir, symlinkPath, 'dir');
  } catch {
    // Fallback if symlinks restricted
  }

  if (fs.existsSync(symlinkPath)) {
    assert(RepositoryRegistry.isAllowed(insideRoot), 'Allowed root passes allowlist');
    assert(!RepositoryRegistry.isAllowed(symlinkPath), 'Symlink pointing outside allowed root is BLOCKED by realpath validation');
    assert(!RepositoryRegistry.isAllowed(outsideDir), 'Raw outside directory is BLOCKED');
  }

  // --- TEST 15: Clean Server Lifecycle & Authenticated End-to-End Delivery ---
  console.log('\n15. Testing Clean Server Lifecycle & Authenticated Delivery...');
  const testServerPort = 3849;
  const testToken = 'secure_audit_remediation_token_999';

  const e2eFactory: AdapterFactory = {
    createPlanningAdapter: () => {
      const emitter = new EventEmitter() as any;
      emitter.execute = async () => {
        setTimeout(() => {
          emitter.emit('event', { type: 'step', data: { plan: 'Delivering file' } });
          emitter.emit('event', { type: 'done', data: { exitCode: 0 } });
        }, 10);
      };
      emitter.abort = async () => {};
      return emitter;
    },
    createCodingAdapter: () => {
      const emitter = new EventEmitter() as any;
      emitter.execute = async (opts: any) => {
        fs.writeFileSync(path.join(opts.cwd, 'audit_verified.ts'), 'export const audit = "passed";\n');
        setTimeout(() => {
          emitter.emit('event', { type: 'done', data: { exitCode: 0 } });
        }, 10);
      };
      emitter.abort = async () => {};
      return emitter;
    }
  };

  const testCoordinator = new AgenticPipelineCoordinator(e2eFactory);
  const { server: testServer } = createOmniDevServer({ token: testToken, coordinator: testCoordinator });

  function dispatchRequest(server: any, options: { method?: string; url: string; headers?: Record<string, string> }): Promise<{ status: number; body: string }> {
    return new Promise((resolve) => {
      const req = new EventEmitter() as any;
      req.method = options.method || 'GET';
      req.url = options.url;
      req.headers = { host: '127.0.0.1', ...options.headers };

      let statusCode = 200;
      let responseBody = '';
      const res = new EventEmitter() as any;
      res.setHeader = () => {};
      res.writeHead = (code: number) => {
        statusCode = code;
      };
      res.end = (chunk?: any) => {
        if (chunk) responseBody += chunk.toString();
        resolve({ status: statusCode, body: responseBody });
      };

      server.emit('request', req, res);
    });
  }

  // Malformed Bearer header (Bearer x against longer secret)
  const malformedRes = await dispatchRequest(testServer, {
    url: '/api/fleet',
    headers: { 'authorization': 'Bearer x' }
  });
  assert(malformedRes.status === 401, 'Malformed short token header returned 401 response without terminating daemon');

  // Authenticated HTTP query
  const authRes = await dispatchRequest(testServer, {
    url: `/api/fleet?token=${testToken}`
  });
  assert(authRes.status === 200, 'Valid token HTTP query accepted with 200');

  // Run end-to-end task through test coordinator
  const e2eRepo = path.join(testBaseDir, 'e2e_final_repo');
  fs.mkdirSync(e2eRepo, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: e2eRepo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: e2eRepo });
  execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: e2eRepo });
  fs.writeFileSync(path.join(e2eRepo, 'init.txt'), 'init\n');
  const e2eOmniDir = path.join(e2eRepo, '.omnidev');
  fs.mkdirSync(e2eOmniDir, { recursive: true });
  fs.writeFileSync(
    path.join(e2eOmniDir, 'config.json'),
    JSON.stringify({ verification: { command: 'node -e process.exit(0)' } })
  );
  execFileSync('git', ['add', '.'], { cwd: e2eRepo });
  execFileSync('git', ['commit', '-m', 'init with verifier'], { cwd: e2eRepo });
  RepositoryRegistry.register(e2eRepo);

  const finalTaskId = `task_final_e2e_${Date.now()}`;
  await new Promise<void>((resolve) => {
    testCoordinator.on('approval_required', (data) => {
      assert(data.candidateCommit.length === 40, 'Candidate commit is a full 40-char git commit SHA');
      assert(data.diff.includes('audit_verified.ts'), 'Diff contains the delivered file');
      testCoordinator.approveTask(data.taskId, data.candidateCommit);
    });

    testCoordinator.on('done', (res) => {
      assert(res.status === 'MERGED_SUCCESSFULLY', 'Pipeline successfully merged exact approved commit object');
      resolve();
    });

    testCoordinator.runPipeline({
      id: finalTaskId,
      repoPath: e2eRepo,
      prompt: 'Deliver audit verified file'
    });
  });

  assert(fs.existsSync(path.join(e2eRepo, 'audit_verified.ts')), 'Delivered file exists in main branch');
  const verifiedContent = fs.readFileSync(path.join(e2eRepo, 'audit_verified.ts'), 'utf8');
  assert(verifiedContent.includes('passed'), 'File content matches verified delivery');

  // --- TEST 16: Source-Mutating Verification Rejection ---
  console.log('\n16. Testing Source-Mutating Verification Rejection...');
  const repo16 = path.join(testBaseDir, 'repo16');
  fs.mkdirSync(repo16, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo16 });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo16 });
  execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: repo16 });
  fs.writeFileSync(path.join(repo16, 'app.ts'), 'export const status = "broken";\n');
  execFileSync('git', ['add', 'app.ts'], { cwd: repo16 });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repo16 });
  RepositoryRegistry.register(repo16);

  // Configure a verifier that attempts to mutate app.ts to "fixed" and exits 0
  const omniDir16 = path.join(repo16, '.omnidev');
  fs.mkdirSync(omniDir16, { recursive: true });
  const mutatingVerifierScript = path.join(omniDir16, 'mutating-verifier.js');
  fs.writeFileSync(
    mutatingVerifierScript,
    `import fs from 'node:fs';
import path from 'node:path';
try {
  fs.writeFileSync(path.resolve('app.ts'), 'export const status = "fixed";\\n');
  process.exit(0);
} catch (err) {
  process.exit(1);
}
`
  );
  fs.writeFileSync(
    path.join(omniDir16, 'config.json'),
    JSON.stringify({ verification: { command: `node ${mutatingVerifierScript}` } })
  );
  execFileSync('git', ['add', '.'], { cwd: repo16 });
  execFileSync('git', ['commit', '-m', 'add mutating verifier'], { cwd: repo16 });

  const mutTaskId = `task_mut_${Date.now()}`;
  let pipelineHaltedOnError = false;

  const mutCoordinator = new AgenticPipelineCoordinator({
    createPlanningAdapter: () => {
      const emitter = new EventEmitter() as any;
      emitter.execute = async () => {
        setTimeout(() => emitter.emit('event', { type: 'done', data: { exitCode: 0 } }), 5);
      };
      emitter.abort = async () => {};
      return emitter;
    },
    createCodingAdapter: () => {
      const emitter = new EventEmitter() as any;
      emitter.execute = async (opts: any) => {
        // Leaves app.ts broken
        fs.writeFileSync(path.join(opts.cwd, 'app.ts'), 'export const status = "broken";\n');
        setTimeout(() => emitter.emit('event', { type: 'done', data: { exitCode: 0 } }), 5);
      };
      emitter.abort = async () => {};
      return emitter;
    }
  });

  mutCoordinator.on('error', () => {
    pipelineHaltedOnError = true;
  });

  await mutCoordinator.runPipeline({
    id: mutTaskId,
    repoPath: repo16,
    prompt: 'Fix app.ts'
  });

  assert(pipelineHaltedOnError, 'Pipeline halted when verifier attempted to mutate source or exited with error');
  const task16 = mutCoordinator.getTask(mutTaskId);
  assert(task16?.status === 'ROLLED_BACK' || task16?.status === 'FAILED', 'Mutating verifier task was rolled back or failed');
  const mainContent16 = fs.readFileSync(path.join(repo16, 'app.ts'), 'utf8');
  assert(!mainContent16.includes('fixed'), 'Unverified candidate was NOT merged into destination repository');

  // --- TEST 17: Confirmed Process Termination on SIGTERM-Resistant Process ---
  console.log('\n17. Testing Confirmed Process Termination on SIGTERM-Resistant Process...');
  const stubbornScript = path.join(testBaseDir, 'stubborn_child.js');
  fs.writeFileSync(
    stubbornScript,
    `process.on('SIGTERM', () => { /* ignore SIGTERM */ });
console.log('READY');
setInterval(() => {}, 1000);
`
  );

  const stubbornChild = spawn('node', [stubbornScript], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });

  const childPid = stubbornChild.pid!;
  assert(typeof childPid === 'number' && childPid > 0, 'Stubborn child process spawned');

  // Wait until process has attached signal handlers and emitted READY
  await new Promise<void>((resolve) => {
    stubbornChild.stdout?.on('data', (chunk) => {
      if (chunk.toString().includes('READY')) resolve();
    });
  });

  function isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  assert(isProcessAlive(childPid), 'Child process is running and ignoring SIGTERM');

  const termStart = Date.now();
  await terminateChildProcess(stubbornChild, 300, 2000);
  const termDuration = Date.now() - termStart;

  assert(!isProcessAlive(childPid), 'Stubborn child process was forcefully terminated with SIGKILL');
  assert(stubbornChild.exitCode !== null || stubbornChild.signalCode !== null, 'Child process exit status is confirmed');
  assert(termDuration >= 280, 'Process killer escalated to SIGKILL after SIGTERM timeout before confirming termination');

  // --- TEST 18: Unverified Candidate Handling & Explicit Override ---
  console.log('\n18. Testing Unverified Candidate Handling & Explicit Override...');
  const repo18 = path.join(testBaseDir, 'repo18');
  fs.mkdirSync(repo18, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo18 });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo18 });
  execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: repo18 });
  fs.writeFileSync(path.join(repo18, 'readme.txt'), 'clean repo without tests\n');
  execFileSync('git', ['add', 'readme.txt'], { cwd: repo18 });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo18 });
  RepositoryRegistry.register(repo18);

  const unvTaskId = `task_unv_${Date.now()}`;
  let approvalData18: any = null;

  const unvCoordinator = new AgenticPipelineCoordinator({
    createPlanningAdapter: () => {
      const emitter = new EventEmitter() as any;
      emitter.execute = async () => {
        setTimeout(() => emitter.emit('event', { type: 'done', data: { exitCode: 0 } }), 5);
      };
      emitter.abort = async () => {};
      return emitter;
    },
    createCodingAdapter: () => {
      const emitter = new EventEmitter() as any;
      emitter.execute = async (opts: any) => {
        fs.writeFileSync(path.join(opts.cwd, 'untested_feature.ts'), 'export const x = 1;\n');
        setTimeout(() => emitter.emit('event', { type: 'done', data: { exitCode: 0 } }), 5);
      };
      emitter.abort = async () => {};
      return emitter;
    }
  });

  unvCoordinator.on('approval_required', (data) => {
    approvalData18 = data;
  });

  await unvCoordinator.runPipeline({
    id: unvTaskId,
    repoPath: repo18,
    prompt: 'Add untested feature',
    autoMergeOnSuccess: true
  });

  assert(approvalData18 !== null, 'Task paused and presented approval_required for unverified candidate');
  assert(approvalData18.verification?.status === 'UNVERIFIED', 'Verification status is explicitly UNVERIFIED');
  assert(approvalData18.verification?.passed === false, 'Unverified code does NOT claim passed: true');

  const task18 = unvCoordinator.getTask(unvTaskId);
  assert(task18?.status === 'AWAITING_APPROVAL', 'Auto-merge was suppressed for UNVERIFIED code');

  let rejectedWithoutOverride = false;
  try {
    unvCoordinator.approveTask(unvTaskId, approvalData18.candidateCommit, { allowUnverified: false });
  } catch {
    rejectedWithoutOverride = true;
  }
  assert(rejectedWithoutOverride, 'Approval without allowUnverified override was rejected');

  let approvedWithOverride = false;
  try {
    unvCoordinator.approveTask(unvTaskId, approvalData18.candidateCommit, { allowUnverified: true });
    approvedWithOverride = true;
  } catch {
    approvedWithOverride = false;
  }
  assert(approvedWithOverride, 'Approval with explicit allowUnverified: true succeeded');
  assert(fs.existsSync(path.join(repo18, 'untested_feature.ts')), 'Feature was merged after explicit unverified approval');

  // --- TEST 19: Destination HEAD Advancement Rejection ---
  console.log('\n19. Testing Destination HEAD Advancement Rejection...');
  const repo19 = path.join(testBaseDir, 'repo19');
  fs.mkdirSync(repo19, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo19 });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo19 });
  execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: repo19 });
  fs.writeFileSync(path.join(repo19, 'base19.txt'), 'base\n');
  execFileSync('git', ['add', 'base19.txt'], { cwd: repo19 });
  execFileSync('git', ['commit', '-m', 'base commit 19'], { cwd: repo19 });

  const worktree19 = WorktreeManager.createWorktree(repo19, `task_adv_${Date.now()}`);
  fs.writeFileSync(path.join(worktree19.worktreePath, 'feature.txt'), 'feature\n');
  const frozen19 = WorktreeManager.freezeCandidate(worktree19);

  // Advance destination branch in main repo after freeze
  fs.writeFileSync(path.join(repo19, 'dest_advance.txt'), 'dest advance\n');
  execFileSync('git', ['add', 'dest_advance.txt'], { cwd: repo19 });
  execFileSync('git', ['commit', '-m', 'dest advance'], { cwd: repo19 });

  let threwDestAdvanced = false;
  try {
    WorktreeManager.applyAndMerge(worktree19, frozen19.candidateCommit);
  } catch (err: any) {
    if (err instanceof DestinationAdvancedException) {
      threwDestAdvanced = true;
    }
  }

  assert(threwDestAdvanced, 'applyAndMerge rejected because destination HEAD advanced after candidate was verified');
  assert(fs.existsSync(worktree19.worktreePath), 'Isolated worktree was retained on disk for recovery');
  WorktreeManager.cleanupWorktree(worktree19);

  // Clean up test base dir
  fs.rmSync(testBaseDir, { recursive: true, force: true });

  console.log(`\n🎉 Hardened Test Suite Completed: ${passed}/${total} assertions passed.\n`);

  // Explicitly check that passed === total before exit
  if (passed === total && (!process.exitCode || process.exitCode === 0)) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
