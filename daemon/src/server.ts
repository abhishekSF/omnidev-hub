import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { HardwareProfiler } from './fleet/hardware-profiler.js';
import { KeepAwakeManager } from './fleet/keepawake.js';
import { PrivacyPolicyEngine } from './compiler/policy.js';
import { AgenticPipelineCoordinator, PipelineTaskRequest } from './compiler/agentic-pipeline.js';
import { RepositoryRegistry } from './repos/registry.js';
import { probeEngines } from './adapters/probe.js';
import { loadOrCreateToken, resolveDataDir, validateToken } from './auth/token.js';
import { parseCookies, SESSION_COOKIE, SessionManager, sessionCookieHeader } from './auth/session.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PWA_DIR = path.resolve(__dirname, '../../pwa');

export const DEFAULT_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3842;
export const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
export const AUTH_TOKEN = process.env.OMNIDEV_TOKEN || '';

export { validateToken, RepositoryRegistry };

const MAX_JSON_BYTES = 64 * 1024;
const WS_MAX_PAYLOAD_BYTES = 256 * 1024;

const PWA_ASSETS: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/manifest.json': { file: 'manifest.json', type: 'application/json; charset=utf-8' }
};

function extractBearer(header: string | undefined): string | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

function resolvePwaAsset(pathname: string): { absPath: string; type: string } | null {
  const asset = PWA_ASSETS[pathname];
  if (!asset) return null;
  // asset.file is a hardcoded basename; never join the raw URL path.
  const absPath = path.resolve(PWA_DIR, asset.file);
  if (path.dirname(absPath) !== path.resolve(PWA_DIR)) return null;
  return { absPath, type: asset.type };
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_JSON_BYTES) {
        fail(httpError(413, 'Request body too large'));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) {
          resolve({});
          return;
        }
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', fail);
  });
}

export interface ServerOptions {
  token?: string;
  coordinator?: AgenticPipelineCoordinator;
  dataDir?: string;
}

export function createOmniDevServer(options: ServerOptions = {}) {
  const token = options.token || AUTH_TOKEN;
  const coordinator = options.coordinator || new AgenticPipelineCoordinator();
  const sessions = new SessionManager(token);

  function isAuthorized(req: http.IncomingMessage): boolean {
    const bearer = extractBearer(req.headers['authorization']);
    if (bearer && validateToken(bearer, token)) return true;
    const cookies = parseCookies(req.headers.cookie);
    return sessions.isValidSession(cookies[SESSION_COOKIE]);
  }

  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const pwaAsset = resolvePwaAsset(url.pathname);
      if (pwaAsset && fs.existsSync(pwaAsset.absPath)) {
        res.writeHead(200, { 'Content-Type': pwaAsset.type });
        res.end(fs.readFileSync(pwaAsset.absPath));
        return;
      }

      if (url.pathname === '/api/session' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const secret = String(body.pairingCode || body.token || '');
        const sessionId = sessions.createSession(secret);
        if (!sessionId) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid pairing code or token.' }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': sessionCookieHeader(sessionId)
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (!isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Unauthorized: send Authorization: Bearer <token> or pair via POST /api/session. Query-string tokens are not accepted.'
        }));
        return;
      }

      if (url.pathname === '/api/session' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname === '/api/fleet') {
        const profile = HardwareProfiler.getProfile();
        const leases = KeepAwakeManager.getActiveLeases();
        const repos = RepositoryRegistry.getAllowedRepositories();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          profile,
          leases,
          allowedRepositories: repos,
          availableEngines: probeEngines()
        }));
        return;
      }

      if (url.pathname === '/api/repos' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ repositories: RepositoryRegistry.getAllowedRepositories() }));
        return;
      }

      if (url.pathname === '/api/repos' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const repoPath = typeof body.path === 'string' ? body.path : '';
        if (!repoPath || !RepositoryRegistry.register(repoPath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Could not register repository. Path must exist and be a directory.' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ repositories: RepositoryRegistry.getAllowedRepositories() }));
        broadcast({
          type: 'REPOS_UPDATED',
          allowedRepositories: RepositoryRegistry.getAllowedRepositories()
        });
        return;
      }

      if (url.pathname === '/api/repos' && req.method === 'DELETE') {
        const body = await readJsonBody(req);
        const repoPath = typeof body.path === 'string' ? body.path : '';
        if (!repoPath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'path is required' }));
          return;
        }
        RepositoryRegistry.unregister(repoPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ repositories: RepositoryRegistry.getAllowedRepositories() }));
        broadcast({
          type: 'REPOS_UPDATED',
          allowedRepositories: RepositoryRegistry.getAllowedRepositories()
        });
        return;
      }

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
        const status = err?.statusCode === 413 ? 413 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: status === 413 ? 'Request body too large' : `Internal Server Error: ${err.message}`
        }));
      }
    }
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

  server.on('upgrade', (req, socket, head) => {
    try {
      if (!isAuthorized(req)) {
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

  function broadcast(data: unknown): void {
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
    ws.send(JSON.stringify({
      type: 'FLEET_INIT',
      profile: HardwareProfiler.getProfile(),
      leases: KeepAwakeManager.getActiveLeases(),
      allowedRepositories: RepositoryRegistry.getAllowedRepositories(),
      availableEngines: probeEngines(),
      pendingApprovals: coordinator.getPendingApprovals()
    }));

    ws.on('message', (message: Buffer | string) => {
      try {
        const payload = JSON.parse(message.toString());

        switch (payload.type) {
          case 'DISPATCH_TASK': {
            const repoPath = payload.repoPath;
            if (!repoPath || !RepositoryRegistry.isAllowed(repoPath)) {
              ws.send(JSON.stringify({
                type: 'ERROR',
                error: `Repository "${repoPath}" is not registered. Add it with the PWA form or: npx tsx src/cli.ts repo add <path>`
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

  return { server, wss, coordinator, token, pairingCode: sessions.getPairingCode(), sessions };
}

const isMain = Boolean(process.argv[1] && (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js')));

if (isMain) {
  const dataDir = resolveDataDir();
  const { token, tokenPath, firstCreated } = loadOrCreateToken(dataDir, process.env.OMNIDEV_TOKEN);
  RepositoryRegistry.setPersistFile(path.join(dataDir, 'repos.json'));
  RepositoryRegistry.loadFromEnv();

  const coordinator = new AgenticPipelineCoordinator(undefined, {
    stateFile: path.join(dataDir, 'state.json')
  });
  const instance = createOmniDevServer({ token, coordinator, dataDir });

  instance.server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    const profile = HardwareProfiler.getProfile();
    const bind = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
    console.log('================================================================');
    console.log(`OmniDev Hub daemon listening on ${bind}`);
    console.log(`Host: ${profile.hostname} (${profile.platform} ${profile.arch})`);
    console.log(`State directory: ${dataDir}`);
    if (firstCreated) {
      console.error(`Auth token written to ${tokenPath}`);
      console.error('This token is printed once. It will not appear in the URL.');
      console.error(token);
    } else if (process.env.OMNIDEV_TOKEN) {
      console.error('Using token from OMNIDEV_TOKEN.');
    } else {
      console.error(`Token loaded from ${tokenPath}`);
    }
    console.error(`Pairing code (10 minutes): ${instance.pairingCode}`);
    console.log(`Open ${bind} and enter the pairing code. Do not put the token in the query string.`);
    const repos = RepositoryRegistry.getAllowedRepositories();
    if (repos.length === 0) {
      console.log('No repositories registered. Add one:');
      console.log(`  cd daemon && npx tsx src/cli.ts repo add /path/to/repo`);
    } else {
      console.log(`Registered repositories: ${repos.length}`);
    }
    console.log('================================================================');
  });
}
