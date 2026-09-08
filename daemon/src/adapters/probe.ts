import { spawnSync } from 'node:child_process';

export interface EngineProbe {
  id: 'cursor' | 'antigravity' | 'opencode' | 'freebuff';
  binary: string;
  available: boolean;
}

const ENGINE_BINARIES: { id: EngineProbe['id']; binary: string }[] = [
  { id: 'cursor', binary: 'agent' },
  { id: 'antigravity', binary: 'agy' },
  { id: 'opencode', binary: 'opencode' },
  { id: 'freebuff', binary: 'freebuff' }
];

function binaryExists(binary: string): boolean {
  try {
    const result = spawnSync(binary, ['--help'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: 'ignore'
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    return !result.error;
  } catch {
    return false;
  }
}

let enginesCache: { at: number; value: EngineProbe[] } | null = null;

export function probeEngines(): EngineProbe[] {
  const now = Date.now();
  if (enginesCache && now - enginesCache.at < 30_000) {
    return enginesCache.value;
  }
  const value = ENGINE_BINARIES.map((engine) => ({
    ...engine,
    available: binaryExists(engine.binary)
  }));
  enginesCache = { at: now, value };
  return value;
}

export function isEngineAvailable(id: EngineProbe['id']): boolean {
  return probeEngines().some((engine) => engine.id === id && engine.available);
}
