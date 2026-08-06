#!/usr/bin/env node
/**
 * FreeDeepseekAPI Router — LLM gateway que roteia chamadas entre múltiplos
 * backends OpenAI-compatíveis, com o proxy DeepSeek embutido (sobe junto).
 *
 * Estratégias de roteamento:
 *   priority  — usa o backend de menor prioridade (1 = mais preferido) que
 *               estiver saudável; fallback automático na ordem.
 *   roundrobin — distribui igualmente entre backends saudáveis.
 *
 * O proxy DeepSeek (server.js) é iniciado como subprocesso automaticamente
 * quando o backend é do tipo "embedded" com autoStart=true — "sobe junto".
 *
 * Uso:
 *   node router.js [--config router.config.json] [--port 9696] [--host 127.0.0.1]
 *                  [--key API_KEY] [--web-password SENHA]
 */
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'router.config.json');
const PROXY_MAIN = path.join(ROOT, 'server.js');

// ── CLI args ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const args = { config: DEFAULT_CONFIG_PATH, port: null, host: null, apiKey: null, webPassword: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--config': args.config = argv[++i]; break;
            case '--port': args.port = Number(argv[++i]); break;
            case '--host': args.host = argv[++i]; break;
            case '--key': args.apiKey = argv[++i]; break;
            case '--web-password': args.webPassword = argv[++i]; break;
            case '--help': args.help = true; break;
        }
    }
    return args;
}

// ── Config loading ──────────────────────────────────────────────────────────
function loadConfig(configPath, cli) {
    let config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        console.error(`[router] ERRO: não foi possível ler ${configPath}: ${e.message}`);
        process.exit(1);
    }
    const r = config.router || {};
    const router = {
        port: cli.port != null ? cli.port : (r.port || 9696),
        host: cli.host || r.host || '127.0.0.1',
        apiKey: cli.apiKey != null ? cli.apiKey : (r.apiKey || ''),
        webPassword: cli.webPassword != null ? cli.webPassword : (r.webPassword || ''),
        healthCheckIntervalSec: r.healthCheckIntervalSec || 60,
        strategy: r.strategy || 'priority',
    };
    const backends = (config.backends || []).map(b => ({
        id: b.id,
        name: b.name || b.id,
        type: b.type || 'openai', // 'embedded' | 'process' | 'openai' | 'anthropic'
        url: b.url || '',
        apiKey: b.apiKey || '',
        autoStart: b.autoStart !== false,
        priority: b.priority || 99,
        models: b.models || ['*'],
        enabled: b.enabled !== false,
        // 'process' type: subprocess externo (ex: QwenBridge)
        cwd: b.cwd || null,
        command: b.command || null,
        args: b.args || [],
        env: b.env || {},
        // runtime state
        alive: false,
        lastCheckedAt: 0,
        lastError: '',
        calls: 0,
        errors: 0,
        lastCallAt: 0,
        proc: null, // embedded subprocess
    }));
    return { router, backends };
}

// ── Embedded/external proxy lifecycle ───────────────────────────────────────
function spawnManagedProcess(backend, file, args, cwd, env, portLabel) {
    const child = spawn(file, args, {
        cwd: cwd || ROOT,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    backend.proc = child;
    child.stdout.on('data', d => process.stdout.write(`[${backend.id}] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[${backend.id}] ${d}`));
    child.on('exit', (code, sig) => {
        console.log(`[router] proxy "${backend.id}" saiu (code=${code} sig=${sig})`);
        backend.proc = null;
        backend.alive = false;
        if (backend.autoStart && !routerShuttingDown) {
            console.log(`[router] reiniciando "${backend.id}" em 5s...`);
            setTimeout(() => startManagedBackend(backend), 5000);
        }
    });
    backend.url = backend.url || `http://127.0.0.1:${portLabel}`;
    console.log(`[router] proxy "${backend.id}" iniciado (pid=${child.pid}, porta ${portLabel})`);
}

function startEmbeddedProxy(backend) {
    if (!backend || backend.type !== 'embedded' || !backend.autoStart) return;
    if (!fs.existsSync(PROXY_MAIN)) {
        backend.lastError = `server.js não encontrado em ${PROXY_MAIN}`;
        return;
    }
    const proxyPort = 9655;
    spawnManagedProcess(backend, process.execPath, [PROXY_MAIN], ROOT, {
        DEEPSEEK_AUTH_DIR: process.env.DEEPSEEK_AUTH_DIR || './accounts',
        NON_INTERACTIVE: '1',
        PORT: String(proxyPort),
        HOST: '127.0.0.1',
    }, proxyPort);
}

function startExternalProcess(backend) {
    if (!backend || backend.type !== 'process' || !backend.autoStart) return;
    if (!backend.command) {
        backend.lastError = 'backend "process" sem comando';
        return;
    }
    if (backend.cwd && !fs.existsSync(backend.cwd)) {
        backend.lastError = `cwd não existe: ${backend.cwd}`;
        console.log(`[router] ERRO: ${backend.lastError}`);
        return;
    }
    spawnManagedProcess(backend, backend.command, backend.args || [], backend.cwd, backend.env || {}, '?');
}

function startManagedBackend(backend) {
    if (backend.type === 'embedded') startEmbeddedProxy(backend);
    else if (backend.type === 'process') startExternalProcess(backend);
}

let routerShuttingDown = false;

// ── Health checks ───────────────────────────────────────────────────────────
async function checkBackend(b) {
    if ((b.type === 'embedded' || b.type === 'process') && !b.proc && b.autoStart) {
        // ainda não iniciado; tenta de novo
        startManagedBackend(b);
        b.alive = false;
        b.lastCheckedAt = Date.now();
        return;
    }
    let ok = false;
    let err = '';
    try {
        const url = b.url.replace(/\/+$/, '');
        const baseUrl = new URL(url);
        // Health check na RAIZ do host (não no path base /v1): /health
        const rootOrigin = baseUrl.origin;
        const probeUrl = (b.type === 'embedded' || b.type === 'process')
            ? `${rootOrigin}/health`
            : `${url}/models`;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(probeUrl, {
            signal: ctrl.signal,
            headers: b.apiKey ? { Authorization: `Bearer ${b.apiKey}` } : {},
        });
        clearTimeout(t);
        ok = res.ok || res.status === 401; // 401 = vivo mas exige key (ainda é um backend respondendo)
        if (!ok) err = `HTTP ${res.status}`;
    } catch (e) {
        err = e.name === 'AbortError' ? 'timeout' : e.message;
    }
    b.alive = ok;
    b.lastCheckedAt = Date.now();
    b.lastError = ok ? '' : err;
    if (!ok && err) console.log(`[router] backend "${b.id}" DOWN: ${err}`);
}

async function healthCheckAll() {
    await Promise.all(backends.filter(b => b.enabled).map(checkBackend));
}

// ── Model resolution ────────────────────────────────────────────────────────
function backendSupportsModel(b, model) {
    if (!b.models || b.models.includes('*')) return true;
    return b.models.includes(model);
}

function pickBackend(model, strategy) {
    const candidates = backends.filter(b => b.enabled && b.alive && backendSupportsModel(b, model));
    if (candidates.length === 0) return null;
    if (strategy === 'roundrobin') {
        return candidates[routerState.rrIndex++ % candidates.length];
    }
    // priority: menor número = maior prioridade
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates[0];
}

// ── HTTP proxy forwarding ───────────────────────────────────────────────────
function forwardRequest(b, clientReq, clientRes, bodyBuffer) {
    const base = b.url.replace(/\/+$/, '');
    // Concatena base + path do cliente sem duplicar segmentos (/v1/v1 bug)
    const reqPath = clientReq.url.split('?')[0];
    const basePath = new URL(base).pathname.replace(/\/+$/, '');
    let fullPath;
    if (reqPath.startsWith(basePath)) {
        fullPath = reqPath; // já inclui o prefixo base
    } else {
        fullPath = basePath + reqPath;
    }
    const query = clientReq.url.includes('?') ? '?' + clientReq.url.split('?')[1] : '';
    const upstream = new URL(base + fullPath.replace(basePath, '') + query);
    if (upstream.pathname === '/' || upstream.pathname === '') {
        upstream.pathname = basePath || '/';
    }
    const headers = { ...clientReq.headers };
    if (b.apiKey) headers['Authorization'] = `Bearer ${b.apiKey}`;
    delete headers['host'];
    headers['host'] = upstream.host;

    const upstreamReq = http.request(upstream, {
        method: clientReq.method,
        headers,
    }, (upstreamRes) => {
        // Passa status + headers pro cliente
        clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
        upstreamRes.on('end', () => {
            b.calls++;
            b.lastCallAt = Date.now();
            if (upstreamRes.statusCode >= 400) b.errors++;
        });
        upstreamRes.on('error', (e) => {
            b.errors++;
            if (!clientRes.headersSent) {
                clientRes.writeHead(502, { 'Content-Type': 'application/json' });
                clientRes.end(JSON.stringify({ error: { message: `upstream error: ${e.message}`, type: 'upstream_error' } }));
            } else clientRes.destroy();
        });
    });
    upstreamReq.on('error', (e) => {
        b.errors++;
        b.alive = false;
        b.lastError = e.message;
        console.log(`[router] backend "${b.id}" erro de conexão: ${e.message}`);
        if (!clientRes.headersSent) {
            clientRes.writeHead(502, { 'Content-Type': 'application/json' });
            clientRes.end(JSON.stringify({ error: { message: `backend "${b.id}" indisponível: ${e.message}`, type: 'backend_unavailable' } }));
        } else clientRes.destroy();
    });
    if (bodyBuffer != null) {
        upstreamReq.end(bodyBuffer);
    } else {
        clientReq.pipe(upstreamReq);
    }
}

// ── Web dashboard ───────────────────────────────────────────────────────────
const WEB_DIR = path.join(ROOT, 'web');
const SESSION_COOKIE = 'router_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map(); // token -> expiresAt

function setSession(res) {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
}

function validSession(req) {
    const m = /(?:^|;\s*)router_session=([^;]+)/.exec(req.headers.cookie || '');
    if (!m) return false;
    const exp = sessions.get(m[1]);
    return exp != null && exp > Date.now();
}

function authOk(req) {
    const h = req.headers['authorization'] || '';
    return routerConfig.apiKey !== '' && h === `Bearer ${routerConfig.apiKey}`;
}

function requireWebAuth(req, res, next) {
    if (routerConfig.webPassword === '' || validSession(req)) return next();
    if (req.url === '/login' && req.method === 'GET') return serveFile(res, 'login.html');
    if (req.url === '/login' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { password } = JSON.parse(body);
                if (password === routerConfig.webPassword) {
                    setSession(res);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } else {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'senha incorreta' }));
                }
            } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'body inválido' }));
            }
        });
        return;
    }
    res.writeHead(302, { Location: '/login' });
    res.end();
}

function serveFile(res, name) {
    const p = path.join(WEB_DIR, name);
    try {
        const content = fs.readFileSync(p);
        const ext = path.extname(p);
        const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(content);
    } catch {
        res.writeHead(404);
        res.end('not found');
    }
}

// ── Metrics ─────────────────────────────────────────────────────────────────
function backendStatus() {
    return backends.map(b => ({
        id: b.id,
        name: b.name,
        type: b.type,
        url: b.url,
        alive: b.alive,
        priority: b.priority,
        models: b.models,
        calls: b.calls,
        errors: b.errors,
        lastCallAt: b.lastCallAt,
        lastCheckedAt: b.lastCheckedAt,
        lastError: b.lastError,
        embedded: b.type === 'embedded' && !!b.proc,
    }));
}

// ── Server ──────────────────────────────────────────────────────────────────
function createServer() {
    return http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        // ── Auth /v1/* ──
        if (url.pathname.startsWith('/v1/') && routerConfig.apiKey !== '') {
            if (!authOk(req)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'API key inválida ou ausente', type: 'invalid_api_key' } }));
                return;
            }
        }

        // ── Web routes ──
        if (url.pathname === '/' || url.pathname === '/dashboard') {
            return requireWebAuth(req, res, () => serveFile(res, 'router.html'));
        }
        if (url.pathname === '/metrics') {
            return requireWebAuth(req, res, () => serveFile(res, 'router-metrics.html'));
        }
        if (url.pathname === '/login') {
            return requireWebAuth(req, res, () => serveFile(res, 'login.html'));
        }
        if (url.pathname === '/logout') {
            res.writeHead(302, { Location: '/', 'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0` });
            res.end();
            return;
        }
        if (url.pathname === '/api/backends') {
            return requireWebAuth(req, res, () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ backends: backendStatus() }));
            });
        }
        if (url.pathname === '/api/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', backends: backendStatus() }));
            return;
        }
        if (url.pathname === '/api/metrics') {
            return requireWebAuth(req, res, () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ backends: backendStatus() }));
            });
        }

        // ── API routing ──
        if (url.pathname.startsWith('/v1/')) {
            // GET /v1/models → merge de modelos de todos os backends
            if (url.pathname === '/v1/models' && req.method === 'GET') {
                const models = [];
                for (const b of backends.filter(x => x.enabled)) {
                    for (const m of b.models) {
                        if (m === '*') continue;
                        if (!models.find(x => x.id === m)) models.push({ id: m, object: 'model', owned_by: b.id });
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ object: 'list', data: models }));
                return;
            }

            // Escolhe backend e encaminha (bufferiza body p/ extrair o modelo)
            let bodyBuffer = null;
            const method = req.method || 'GET';
            if (method === 'POST' || method === 'PUT') {
                bodyBuffer = await readBody(req, 64 * 1024 * 1024); // até 64MB
            }
            const model = extractModel(bodyBuffer ? bodyBuffer.toString('utf8') : '');
            const backend = pickBackend(model, routerConfig.strategy);
            if (!backend) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Nenhum backend disponível para o modelo solicitado', type: 'no_backend_available' } }));
                return;
            }
            forwardRequest(backend, req, res, bodyBuffer);
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rota não encontrada', type: 'not_found' } }));
    });
}

// Precisamos ler o body pra extrair o modelo; cacheamos pra reencaminhar
const clientReqBodyCache = new WeakMap();

function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on('data', c => {
            total += c.length;
            if (total > maxBytes) {
                reject(new Error('body muito grande'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function extractModel(body) {
    try {
        const d = JSON.parse(body);
        return d.model || '';
    } catch { return ''; }
}

// ── Main ────────────────────────────────────────────────────────────────────
let routerConfig = null;
let backends = [];
let routerState = { rrIndex: 0 };

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(`Uso: node router.js [--config path] [--port N] [--host H] [--key K] [--web-password S]
  --config        caminho do config (default: router.config.json)
  --port          porta do roteador (default: 9696)
  --host          host do roteador (default: 127.0.0.1)
  --key           API key exigida nas chamadas /v1/*
  --web-password  senha para o dashboard web`);
        process.exit(0);
    }

    const { router, backends: bks } = loadConfig(args.config, args);
    routerConfig = router;
    backends = bks;

    console.log(`[router] FreeDeepseekAPI Router — ${backends.length} backend(s), estratégia: ${routerConfig.strategy}`);

    // Inicia embedded/external proxies ("sobe junto")
    for (const b of backends) {
        if (b.enabled && (b.type === 'embedded' || b.type === 'process')) startManagedBackend(b);
    }

    // Health check inicial + periódico
    setTimeout(healthCheckAll, 1500);
    setInterval(healthCheckAll, routerConfig.healthCheckIntervalSec * 1000).unref();

    const server = createServer();
    server.listen(routerConfig.port, routerConfig.host, () => {
        console.log(`[router] roteador em http://${routerConfig.host}:${routerConfig.port}`);
        console.log(`[router] dashboard: http://localhost:${routerConfig.port}/`);
        console.log(`[router] API: http://localhost:${routerConfig.port}/v1`);
    });

    const shutdown = () => {
        routerShuttingDown = true;
        for (const b of backends) {
            if (b.proc) {
                console.log(`[router] encerrando proxy "${b.id}"...`);
                b.proc.kill('SIGTERM');
            }
        }
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if (require.main === module) {
    main().catch(e => { console.error('[router] FATAL:', e); process.exit(1); });
}

// ── Test hooks ──────────────────────────────────────────────────────────────
function joinBaseAndPath(base, reqPath) {
    base = base.replace(/\/+$/, '');
    const basePath = new URL(base).pathname.replace(/\/+$/, '');
    let fullPath;
    if (reqPath.startsWith(basePath)) {
        fullPath = reqPath;
    } else {
        fullPath = basePath + reqPath;
    }
    return base + fullPath.replace(basePath, '');
}

function pickBackendForList(bkList, strategy, model) {
    const candidates = bkList.filter(b => b.enabled && b.alive && backendSupportsModel(b, model));
    if (candidates.length === 0) return null;
    if (strategy === 'roundrobin') {
        return candidates[routerState.rrIndex++ % candidates.length];
    }
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates[0];
}

if (require.main !== module) {
    module.exports.__test = { joinBaseAndPath, extractModel, pickBackend: pickBackendForList };
}
