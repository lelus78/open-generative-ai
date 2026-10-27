// A small MCP server (Streamable HTTP, JSON responses) so an AI assistant — Claude Code, Cursor, a
// DeepSeek-backed client... — can drive this app while it is open, the way the Blender MCP drives
// Blender. Only the protocol lives here; what the tools do is in mcpTools.js.
//
// Safety: it listens on 127.0.0.1 only, needs a bearer token, and refuses browser requests (an
// Origin header) so a web page cannot start generations on this PC.
const http = require('http');
const crypto = require('crypto');

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY_BYTES = 1024 * 1024;

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/**
 * @param {{ name: string, version: string, instructions?: string,
 *   tools: Array<{ name: string, title?: string, description: string, inputSchema: object, annotations?: object, run: (args: object) => Promise<{ content: object[], structuredContent?: object }> }>,
 *   prompts?: Array<{ name: string, title?: string, description: string, arguments?: Array<{ name: string, description: string, required?: boolean }>, build: (args: object) => string }> }} options
 * @returns {(message: object) => Promise<object|null>} resolves to the JSON-RPC response, or null for notifications
 */
function createHandler({ name, version, tools, instructions, prompts = [] }) {
    const byName = new Map(tools.map(t => [t.name, t]));
    const promptByName = new Map(prompts.map(p => [p.name, p]));
    // Only the fields of the protocol: `run` and `build` stay on this side.
    const listTool = ({ name: n, title, description, inputSchema, annotations }) => ({ name: n, ...(title ? { title } : {}), description, inputSchema, ...(annotations ? { annotations } : {}) });
    const listPrompt = ({ name: n, title, description, arguments: args }) => ({ name: n, ...(title ? { title } : {}), description, arguments: args || [] });

    return async function handle(message) {
        if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
            return fail(message?.id, -32600, 'Invalid request');
        }
        const { id, method, params } = message;
        const isNotification = id === undefined || id === null;

        if (method.startsWith('notifications/')) return null;

        switch (method) {
            case 'initialize': {
                const wanted = params?.protocolVersion;
                return ok(id, {
                    protocolVersion: SUPPORTED_PROTOCOLS.includes(wanted) ? wanted : SUPPORTED_PROTOCOLS[1],
                    capabilities: { tools: { listChanged: false }, ...(prompts.length ? { prompts: { listChanged: false } } : {}) },
                    serverInfo: { name, version },
                    ...(instructions ? { instructions } : {}),
                });
            }
            case 'ping':
                return ok(id, {});
            case 'tools/list':
                return ok(id, { tools: tools.map(listTool) });
            case 'prompts/list':
                return ok(id, { prompts: prompts.map(listPrompt) });
            case 'prompts/get': {
                const prompt = promptByName.get(params?.name);
                if (!prompt) return fail(id, -32602, `Unknown prompt: ${params?.name}`);
                const args = params?.arguments || {};
                const missing = (prompt.arguments || []).filter(a => a.required && !String(args[a.name] ?? '').trim()).map(a => a.name);
                if (missing.length) return fail(id, -32602, `Missing argument: ${missing.join(', ')}`);
                return ok(id, { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text: prompt.build(args) } }] });
            }
            case 'tools/call': {
                const tool = byName.get(params?.name);
                if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
                try {
                    return ok(id, await tool.run(params?.arguments || {}));
                } catch (err) {
                    // Tool failures are reported to the model as a result, so it can read the reason and retry.
                    return ok(id, { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] });
                }
            }
            default:
                return isNotification ? null : fail(id, -32601, `Method not found: ${method}`);
        }
    };
}

const safeEqual = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Decide whether an HTTP request may reach the handler. Returns an HTTP status (200 = allowed). */
function authorize({ headers, token, port }) {
    if (headers.origin) return 403;                                   // browsers send Origin; MCP clients do not
    const host = String(headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return 403;   // DNS-rebinding guard
    const match = /^Bearer\s+(.+)$/i.exec(String(headers.authorization || ''));
    if (!match || !safeEqual(match[1].trim(), token)) return 401;
    return 200;
}

function start({ port, token, handle }) {
    const server = http.createServer((req, res) => {
        const send = (status, body, extra = {}) => {
            res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
            res.end(body === undefined ? undefined : JSON.stringify(body));
        };

        const status = authorize({ headers: req.headers, token, port });
        if (status !== 200) return send(status, { error: status === 401 ? 'Unauthorized' : 'Forbidden' });
        if (new URL(req.url, 'http://x').pathname !== '/mcp') return send(404, { error: 'Not found' });
        if (req.method === 'DELETE') return send(200, {});
        if (req.method !== 'POST') return send(405, { error: 'Use POST' }, { Allow: 'POST, DELETE' });

        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) { send(413, { error: 'Request too large' }); req.destroy(); return; }
            chunks.push(chunk);
        });
        req.on('end', async () => {
            if (res.writableEnded) return;
            let payload;
            try { payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')); }
            catch { return send(400, fail(null, -32700, 'Parse error')); }

            const responses = (await Promise.all((Array.isArray(payload) ? payload : [payload]).map(handle))).filter(Boolean);
            if (!responses.length) { res.writeHead(202); res.end(); return; }
            send(200, Array.isArray(payload) ? responses : responses[0]);
        });
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
    });
}

module.exports = { createHandler, authorize, start, SUPPORTED_PROTOCOLS };
