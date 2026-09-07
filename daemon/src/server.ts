import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { HardwareProfiler } from './fleet/hardware-profiler.js';
import { KeepAwakeManager } from './fleet/keepawake.js';
import { PrivacyPolicyEngine } from './compiler/policy.js';
import { AgenticPipelineCoordinator, PipelineTaskRequest } from './compiler/agentic-pipeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PWA_DIR = path.resolve(__dirname, '../../pwa');

export const DEFAULT_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3842;
export const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
export const AUTH_TOKEN = process.env.OMNIDEV_TOKEN || crypto.randomBytes(24).toString('hex');

/**
 * Validates bearer/query tokens safely using UTF-8 byte length comparison
 * before timingSafeEqual to avoid ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH crashes.
 */
export function validateToken(tokenStr: string | null | undefined, expectedToken: string = AUTH_TOKEN): boolean {
  if (!tokenStr || typeof tokenStr !== 'string') return false;
  try {
    const tokenBuf = Buffer.from(tokenStr, 'utf8');
    const authBuf = Buffer.from(expectedToken, 'utf8');
    if (tokenBuf.length !== authBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(tokenBuf, authBuf);
  } catch {
    return false;
  }
}

/**
 * Repository Registry with strict symlink canonicalization.
 * Evaluates real filesystem destinations to prevent symlink bypasses.
 */
export class RepositoryRegistry {
  private static allowedRoots: Set<string> = new Set(
    process.env.OMNIDEV_ALLOWED_REPOS
      ? process.env.OMNIDEV_ALLOWED_REPOS.split(path.delimiter).map(p => {
          try { return fs.realpathSync(path.resolve(p)); } catch { return ''; }
        }).filter(Boolean)
      : [fs.realpathSync(path.resolve(process.cwd()))]
  );

  public static register(dirPath: string): void {
    try {
      const resolved = fs.realpathSync(path.resolve(dirPath));
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        this.allowedRoots.add(resolved);
      }
    } catch {
      // Non-existent or invalid directory rejected
    }
  }

  public static unregister(dirPath: string): void {
    try {
      const resolved = fs.realpathSync(path.resolve(dirPath));
      this.allowedRoots.delete(resolved);
    } catch {
      this.allowedRoots.delete(dirPath);
    }
  }

  public static setAllowedRoots(roots: string[]): void {
    this.allowedRoots.clear();
    for (const r of roots) {
      this.register(r);
    }
  }

  public static clear(): void {
    this.allowedRoots.clear();
  }

  public static resetToDefaults(): void {
    this.allowedRoots.clear();
    try {
      this.allowedRoots.add(fs.realpathSync(path.resolve(process.cwd())));
    } catch {}
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
}

export function createOmniDevServer(options: { token?: string; coordinator?: AgenticPipelineCoordinator } = {}) {
  const token = options.token || AUTH_TOKEN;
  const coordinator = options.coordinator || new AgenticPipelineCoordinator();

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      function checkAuth(): boolean {
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
          return validateToken(authHeader.slice(7).trim(), token);
        }
        const queryToken = url.searchParams.get('token');
        return validateToken(queryToken, token);
      }

      // Static PWA files (served without sensitive data)
      if (url.pathname === '/' || url.pathname.startsWith('/app.js') || url.pathname.startsWith('/manifest.json')) {
        let filePath = path.join(PWA_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
        if (fs.existsSync(filePath)) {
          const ext = path.extname(filePath);
          const contentTypes: Record<string, string> = {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.json': 'application/json'
          };
          res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
          fs.createReadStream(filePath).pipe(res);
          return;
        }
      }

      // API routes require token authentication
      if (!checkAuth()) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid Bearer token or ?token=...' }));
        return;
      }

      // API: Fleet telemetry
      if (url.pathname === '/api/fleet') {
        const profile = HardwareProfiler.getProfile();
        const leases = KeepAwakeManager.getActiveLeases();
        const repos = RepositoryRegistry.getAllowedRepositories();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ profile, leases, allowedRepositories: repos }));
        return;
      }

      // API: Privacy Policy check (restricted to allowed repositories)
      if (url.pathname === '/api/privacy') {
        const targetRepo = url.searchParams.get('repo');
        if (!targetRepo || !RepositoryRegistry.isAllowed(targetRepo)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden: repository path is not in the approved RepositoryRegistry.' }));
          return;
        }
        const report = PrivacyPolicyEngine.evaluateRepository(targetRepo);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (err: any) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Internal Server Error: ${err.message}` }));
      }
    }
  });

  // WebSocket Server with strict upgrade authentication
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const queryToken = url.searchParams.get('token');
      const authHeader = req.headers['authorization'];
      let isAuthorized = false;

      if (queryToken) {
        isAuthorized = validateToken(queryToken, token);
      } else if (authHeader && authHeader.startsWith('Bearer ')) {
        isAuthorized = validateToken(authHeader.slice(7).trim(), token);
      }

      if (!isAuthorized) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
    }
  });

  function broadcast(data: any): void {
    const msg = JSON.stringify(data);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  coordinator.on('log', (msg) => broadcast({ type: 'LOG', message: msg }));
  coordinator.on('stage', (stage) => broadcast({ type: 'STAGE', stage }));
  coordinator.on('adapter_event', (data) => broadcast({ type: 'ADAPTER_EVENT', data }));
  coordinator.on('approval_required', (data) => broadcast({ type: 'APPROVAL_REQUIRED', data }));
  coordinator.on('done', (data) => broadcast({ type: 'DONE', data }));
  coordinator.on('error', (err) => broadcast({ type: 'ERROR', error: err }));

  wss.on('connection', (ws) => {
    // Send full state replay on connection
    ws.send(JSON.stringify({
      type: 'FLEET_INIT',
      profile: HardwareProfiler.getProfile(),
      leases: KeepAwakeManager.getActiveLeases(),
      allowedRepositories: RepositoryRegistry.getAllowedRepositories(),
      pendingApprovals: coordinator.getPendingApprovals()
    }));

    ws.on('message', (message: string) => {
      try {
        const payload = JSON.parse(message.toString());

        switch (payload.type) {
          case 'DISPATCH_TASK': {
            const repoPath = payload.repoPath;
            if (!repoPath || !RepositoryRegistry.isAllowed(repoPath)) {
              ws.send(JSON.stringify({
                type: 'ERROR',
                error: `Repository "${repoPath}" is not registered in RepositoryRegistry. Access denied.`
              }));
              return;
            }

            const req: PipelineTaskRequest = {
              id: payload.id || `task_${Date.now()}`,
              repoPath,
              prompt: payload.prompt,
              forceEngine: payload.engine || 'auto'
            };
            coordinator.runPipeline(req);
            break;
          }

          case 'APPROVE_TASK': {
            if (!payload.candidateCommit) {
              ws.send(JSON.stringify({
                type: 'ERROR',
                error: 'Approval rejected: candidateCommit hash is required to bind approval to reviewed content.'
              }));
              return;
            }
            coordinator.approveTask(payload.taskId, payload.candidateCommit, { allowUnverified: !!payload.allowUnverified });
            break;
          }

          case 'REJECT_TASK': {
            coordinator.abortTask(payload.taskId);
            break;
          }

          default:
            console.warn('[WebSocket] Unknown payload type:', payload.type);
        }
      } catch (err: any) {
        ws.send(JSON.stringify({ type: 'ERROR', error: err.message }));
      }
    });
  });

  return { server, wss, coordinator, token };
}

// Global server instance for standalone execution
const defaultInstance = createOmniDevServer({ token: AUTH_TOKEN });
export const server = defaultInstance.server;
export const coordinator = defaultInstance.coordinator;

// Auto-start listener only when executed directly as main script
const isMain = process.argv[1] && (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'));
if (isMain) {
  server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    const profile = HardwareProfiler.getProfile();
    console.log('================================================================');
    console.log(`⚡ OmniDev Hub Daemon running on http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
    console.log(`🔑 Auth Token: ${AUTH_TOKEN}`);
    console.log(`📱 Mobile Connect URL: http://${DEFAULT_HOST}:${DEFAULT_PORT}?token=${AUTH_TOKEN}`);
    console.log(`💻 Host: ${profile.hostname} (${profile.platform} ${profile.arch}) - Tier: ${profile.computeTier}`);
    console.log('================================================================');
  });
}
