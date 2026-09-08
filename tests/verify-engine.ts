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
  assert(profile.cpuCores > 0, `CPU cores detected: ${profile.cpuCores} cores');
