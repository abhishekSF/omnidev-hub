import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export type PrivacyLevel = 'STRICT_PRIVATE' | 'PUBLIC_SCRATCH';

export const CANONICAL_ENGINES = [
  'cursor',
  'antigravity',
  'ollama-local',
  'opencode',
  'freebuff'
] as const;

export type CanonicalEngine = typeof CANONICAL_ENGINES[number];

export interface RepositoryPrivacyReport {
  repoPath: string;
  privacyLevel: PrivacyLevel;
  reasons: string[];
  allowedEngines: string[];
  prohibitedEngines: string[];
}

export class PrivacyPolicyEngine {
  private static readonly SECRET_FILES = [
    '.env',
    '.env.local',
    '.env.production',
    'credentials.json',
    'secrets.yaml',
    'secrets.json',
    'service-account.json',
    'id_rsa',
    'id_ed25519'
  ];

  public static evaluateRepository(rawRepoPath: string): RepositoryPrivacyReport {
    let repoPath = path.resolve(rawRepoPath);
    try {
      repoPath = fs.realpathSync(repoPath);
    } catch {
      // Keep the resolved path if realpath fails (missing or dangling)
    }
    const reasons: string[] = [];
    let hasSecrets = false;

    // Check 1: Mandatory Secret Artifact Inspection (CANNOT be bypassed by config)
    if (fs.existsSync(repoPath)) {
      for (const file of this.SECRET_FILES) {
        if (fs.existsSync(path.join(repoPath, file))) {
          reasons.push(`Sensitive credentials detected on disk (${file})`);
          hasSecrets = true;
        }
      }
    }

    // Check 2: Git Remote Inspection (No shell interpolation)
    let hasPrivateRemote = false;
    try {
      const gitRemote = execFileSync('git', ['remote', '-v'], {
        cwd: repoPath,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      });

      if (gitRemote.trim().length > 0) {
        const lower = gitRemote.toLowerCase();
        if (!lower.includes('github.com') && !lower.includes('gitlab.com')) {
          reasons.push('Internal/Enterprise Git remote detected');
          hasPrivateRemote = true;
        }
        if (lower.includes('private') || lower.includes('internal') || lower.includes('corp')) {
          reasons.push('Git remote contains private/internal keywords');
          hasPrivateRemote = true;
        }
      }
    } catch {
      // Not a git repository or git command unavailable
    }

    // Check 3: Explicit configuration ONLY IF no secrets exist
    let isPrivate = true;
    const omniDevConfigFile = path.join(repoPath, '.omnidev', 'config.json');
    if (!hasSecrets && fs.existsSync(omniDevConfigFile)) {
      try {
        const config = JSON.parse(fs.readFileSync(omniDevConfigFile, 'utf8'));
        if (config.privacy === 'PUBLIC_SCRATCH') {
          return {
            repoPath,
            privacyLevel: 'PUBLIC_SCRATCH',
            reasons: ['Explicitly declared PUBLIC_SCRATCH in .omnidev/config.json with zero secret files detected'],
            allowedEngines: [...CANONICAL_ENGINES],
            prohibitedEngines: []
          };
        } else if (config.privacy === 'STRICT_PRIVATE') {
          reasons.push('Explicitly marked STRICT_PRIVATE in .omnidev/config.json');
          isPrivate = true;
        }
      } catch {
        // Fallback to strict safe
      }
    }

    if (hasSecrets) {
      reasons.push('Secret files detected: Forced to STRICT_PRIVATE regardless of configuration');
      isPrivate = true;
    } else if (hasPrivateRemote) {
      isPrivate = true;
    } else if (reasons.length === 0) {
      reasons.push('Default Zero-Trust Security Policy: unverified repository defaults to STRICT_PRIVATE');
      isPrivate = true;
    }

    const privacyLevel: PrivacyLevel = isPrivate ? 'STRICT_PRIVATE' : 'PUBLIC_SCRATCH';

    // Strict allowlist: private repos ONLY permit zero-retention private engines
    const allowedEngines = isPrivate
      ? ['cursor', 'antigravity', 'ollama-local']
      : [...CANONICAL_ENGINES];

    const prohibitedEngines = CANONICAL_ENGINES.filter(e => !allowedEngines.includes(e));

    return {
      repoPath,
      privacyLevel,
      reasons,
      allowedEngines,
      prohibitedEngines
    };
  }

  public static assertDispatchAllowed(repoPath: string, engineId: string): void {
    const report = this.evaluateRepository(repoPath);

    // DEFAULT-DENY ENFORCEMENT: engine MUST be explicitly present in allowedEngines
    if (!report.allowedEngines.includes(engineId)) {
      throw new Error(
        `[PRIVACY FENCING VIOLATION] Engine '${engineId}' is not allowed for repository '${repoPath}'. ` +
        `This repository is flagged as ${report.privacyLevel}. Reasons: ${report.reasons.join('; ')}. ` +
        `Allowed engines: [${report.allowedEngines.join(', ')}]. ` +
        `Default-deny rule blocked this dispatch.`
      );
    }
  }
}
