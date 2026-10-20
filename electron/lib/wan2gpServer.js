// Keeps one local `wgp.py --mcp` process alive between generations, so the (large) model stays loaded
// in RAM instead of being read, quantized and moved to the GPU again for every image.
// It stops by itself after a period without use, and when the app quits.
const net = require('net');
const local = require('./wan2gpLocal');

const IDLE_STOP_MS = 20 * 60 * 1000;
const START_TIMEOUT_MS = 300 * 1000;

let server = null; // { child, url, key, ready: Promise<string>, idleTimer }

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

async function waitUntilUp(port, child) {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Wan2GP server exited while starting.');
        try {
            const res = await fetch(`http://127.0.0.1:${port}/config`, { signal: AbortSignal.timeout(1500) });
            if (res.status < 500) return;
        } catch { /* not listening yet */ }
        await new Promise(r => setTimeout(r, 700));
    }
    throw new Error('Wan2GP server did not start in time.');
}

function stop() {
    if (!server) return;
    clearTimeout(server.idleTimer);
    local.killTree(server.child);
    server = null;
}

function touch() {
    if (!server) return;
    clearTimeout(server.idleTimer);
    server.idleTimer = setTimeout(stop, IDLE_STOP_MS);
    server.idleTimer.unref?.();
}

/** Resolves to the MCP URL of the local server, starting it when needed. Rejects if it cannot start. */
async function ensure(install) {
    const key = `${install.python}|${install.wgpPath}`;
    if (server && server.key !== key) stop();
    if (server && (server.child.exitCode !== null || server.child.signalCode !== null)) server = null;
    if (!server) {
        const port = await freePort();
        const child = local.spawnWgp(install, ['--mcp', '--mcp-api-version', '1', '--mcp-transport', 'streamable-http', '--mcp-host', '127.0.0.1', '--mcp-port', String(port)]);
        child.stdout.on('data', () => {});
        child.stderr.on('data', () => {});
        child.on('close', () => { if (server && server.child === child) { clearTimeout(server.idleTimer); server = null; } });
        const current = { child, key, url: `http://127.0.0.1:${port}/mcp`, idleTimer: null };
        current.ready = waitUntilUp(port, child).then(() => current.url);
        server = current;
        current.ready.catch(() => { if (server === current) stop(); });
    }
    const current = server;
    const url = await current.ready;
    touch();
    return url;
}

module.exports = { ensure, stop, touch };
