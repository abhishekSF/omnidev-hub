import fs from 'node:fs';
import path from 'node:path';

interface PersistedRepos {
  version: 1;
  roots: string[];
}

/**
 * Explicit repository allowlist. There is no implicit cwd default —
 * a path must be registered via env, disk, CLI, or POST /api/repos.
 */
export class RepositoryRegistry {
  private static allowedRoots: Set<string> = new Set();
  private static persistFile: string | null = null;

  public static setPersistFile(file: string | null): void {
    this.persistFile = file;
    if (file) {
      this.loadFromDisk();
    }
  }

  public static loadFromEnv(): void {
    const raw = process.env.OMNIDEV_ALLOWED_REPOS;
    if (!raw) return;
    for (const p of raw.split(path.delimiter)) {
      if (p.trim()) this.register(p, false);
    }
  }

  public static register(dirPath: string, persist = true): boolean {
    try {
      const resolved = fs.realpathSync(path.resolve(dirPath));
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        this.allowedRoots.add(resolved);
        if (persist) this.persist();
        return true;
      }
    } catch {
      // Non-existent or invalid directory rejected
    }
    return false;
  }

  public static unregister(dirPath: string, persist = true): void {
    try {
      const resolved = fs.realpathSync(path.resolve(dirPath));
      this.allowedRoots.delete(resolved);
    } catch {
      this.allowedRoots.delete(dirPath);
    }
    if (persist) this.persist();
  }

  public static setAllowedRoots(roots: string[]): void {
    this.allowedRoots.clear();
    for (const r of roots) {
      this.register(r, false);
    }
    this.persist();
  }

  public static clear(): void {
    this.allowedRoots.clear();
  }

  public static resetToDefaults(): void {
    this.allowedRoots.clear();
    this.loadFromEnv();
  }

  public static getAllowedRepositories(): string[] {
    return Array.from(this.allowedRoots.values());
  }

  public static isAllowed(candidatePath: string): boolean {
    try {
      if (!fs.existsSync(candidatePath)) return false;
      const realCandidate = fs.realpathSync(path.resolve(candidatePath));

      for (const root of this.allowedRoots) {
        let realRoot: string;
        try {
          realRoot = fs.realpathSync(root);
        } catch {
          continue;
        }

        if (realCandidate === realRoot || realCandidate.startsWith(realRoot + path.sep)) {
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  private static loadFromDisk(): void {
    if (!this.persistFile || !fs.existsSync(this.persistFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistFile, 'utf8')) as PersistedRepos;
      if (!raw || raw.version !== 1 || !Array.isArray(raw.roots)) return;
      for (const root of raw.roots) {
        this.register(root, false);
      }
    } catch {
      // Corrupt registry is treated as empty
    }
  }

  private static persist(): void {
    if (!this.persistFile) return;
    const dir = path.dirname(this.persistFile);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload: PersistedRepos = {
      version: 1,
      roots: this.getAllowedRepositories()
    };
    const tmp = this.persistFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.persistFile);
  }
}

RepositoryRegistry.loadFromEnv();
