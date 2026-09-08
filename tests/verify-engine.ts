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

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
