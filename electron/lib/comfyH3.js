// MiniMax H3 reference-to-video through the user's own ComfyUI. We never bundle Python or weights:
// the user points the app at a ComfyUI folder that has the H3 files (see h3:status for what is missing).
// ComfyUI is started hidden on demand, re-used between generations, and stopped after a while unused.
// While it samples, ComfyUI streams step counts and latent previews over its WebSocket; we forward
// them to the window so a run that goes wrong can be stopped early.

const { ipcMain, app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { resolveLocalAiPaths } = require('./localInferencePaths');
const outputStore = require('./outputStore');
const miniWs = require('./miniWs');
const { shared: debug, gpuSnapshot } = require('./debugLog');
const { composeH3Prompt } = require('./comfyH3Prompt');
const { killTree } = require('./wan2gpLocal');
const {
    MODEL_PATHS, NODE_BASE_SAMPLER, NODE_REFINE_SAMPLER, NODE_SAVE, MAX_REFERENCES, buildH3Graph,
} = require('./comfyH3Workflow');

const CONFIG_DIR = path.join(app.getPath('userData'), 'local-ai');
const CONFIG_FILE = path.join(CONFIG_DIR, 'comfy-h3.json');
const WORK_DIR = path.join(resolveLocalAiPaths({ userDataPath: app.getPath('userData') }).dataDir, 'comfy-h3');
const RUNS_DIR = path.join(WORK_DIR, 'runs');
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const DEFAULT_PORT = 8188;
const IDLE_STOP_MS = 15 * 60 * 1000;
const START_TIMEOUT_MS = 180 * 1000;
const PREVIEW_MIN_INTERVAL_MS = 400;

// ─── Config ──────────────────────────────────────────────────────
function readConfig() {
    try { return { dir: '', python: '', ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) }; }
    catch { return { dir: '', python: '' }; }
}
function writeConfig(cfg) {
    const next = { dir: (cfg.dir || '').trim(), python: (cfg.python || '').trim() };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
    return next;
}

/** python.exe of the venv that belongs to a ComfyUI folder (own venv, a sibling venv, or the portable build). */
function resolvePython(dir, python) {
    if ((python || '').trim()) return python.trim();
    const win = process.platform === 'win32';
    const candidates = win
        ? [['venv', 'Scripts', 'python.exe'], ['..', 'venv', 'Scripts', 'python.exe'], ['..', 'python_embeded', 'python.exe']]
        : [['venv', 'bin', 'python'], ['..', 'venv', 'bin', 'python']];
    for (const parts of candidates) {
        const candidate = path.join(dir, ...parts);
        if (fs.existsSync(candidate)) return candidate;
    }
    return '';
}

/** What is installed in the ComfyUI folder, and what the user still has to add. */
function inspectInstall(cfg = readConfig()) {
    const dir = cfg.dir;
    if (!dir) return { ok: false, configured: false, error: 'Choose your ComfyUI folder first.', missing: [] };
    if (!fs.existsSync(path.join(dir, 'main.py'))) return { ok: false, configured: true, dir, error: 'main.py not found in that folder — pick the ComfyUI folder itself.', missing: [] };
    const python = resolvePython(dir, cfg.python);
    if (!python) return { ok: false, configured: true, dir, error: 'No Python environment found next to ComfyUI.', missing: [] };
    const missing = Object.entries(MODEL_PATHS)
        .filter(([key]) => key !== 'upscaler')
        .filter(([, parts]) => !fs.existsSync(path.join(dir, ...parts)))
        .map(([, parts]) => parts.slice(1).join('/'));
    const customNodes = path.join(dir, 'custom_nodes');
    let upscalerNode = false;
    try { upscalerNode = fs.readdirSync(customNodes).some((name) => /minimax.?h3.*upscal/i.test(name)); } catch { /* no custom_nodes */ }
    const upscalerModel = fs.existsSync(path.join(dir, ...MODEL_PATHS.upscaler));
    return {
        ok: missing.length === 0, configured: true, dir, python, missing,
        upscaler: upscalerNode && upscalerModel,
        upscalerHint: upscalerNode ? (upscalerModel ? '' : `Missing ${MODEL_PATHS.upscaler.slice(1).join('/')}`) : 'Custom node "Comfyui_Minimax_h3_latent_Upscaler" is not installed',
        error: missing.length ? `Missing files: ${missing.join(', ')}` : '',
    };
}

// ─── ComfyUI process ──────────────────────────────────────────────
let server = null; // { child|null, port, key, external, ready, idleTimer }

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

async function isUp(port, timeout = 1500) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/system_stats`, { signal: AbortSignal.timeout(timeout) });
        return res.ok;
    } catch { return false; }
}

async function waitUntilUp(port, child) {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('ComfyUI exited while starting — open it by hand once to see the error.');
        if (await isUp(port)) return;
        await new Promise((r) => setTimeout(r, 800));
    }
    throw new Error('ComfyUI did not start in time.');
}

function stopServer(reason = 'requested') {
    if (!server) return;
    clearTimeout(server.idleTimer);
    debug.info('h3', server.external ? 'letting go of the ComfyUI that was already running' : 'stopping ComfyUI', { reason, port: server.port });
    if (!server.external) { server.child.stopping = reason; killTree(server.child); } // read back by the child's 'close' handler
    server = null;
}

function touchServer() {
    if (!server || server.external) return;
    clearTimeout(server.idleTimer);
    server.idleTimer = setTimeout(() => stopServer('unused for 15 minutes'), IDLE_STOP_MS);
    server.idleTimer.unref?.();
}

/** Resolves to the port of a ready ComfyUI. A ComfyUI the user already runs on 8188 is re-used and never stopped. */
async function ensureServer(install) {
    const key = `${install.python}|${install.dir}`;
    if (server && server.key !== key) stopServer();
    if (server && !server.external && (server.child.exitCode !== null || server.child.signalCode !== null)) server = null;
    if (!server) {
        if (await isUp(DEFAULT_PORT)) {
            server = { child: null, port: DEFAULT_PORT, key, external: true, ready: Promise.resolve(DEFAULT_PORT), idleTimer: null };
            debug.info('h3', 'using the ComfyUI that is already running', { port: DEFAULT_PORT });
        } else {
            const port = await freePort();
            const child = spawn(install.python, ['main.py', '--listen', '127.0.0.1', '--port', String(port), '--preview-method', 'latent2rgb', '--disable-auto-launch'], {
                cwd: install.dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
            });
            // Keep the tail of ComfyUI's own console: it is what explains a crash (out of memory, a bad node...).
            const consoleTail = [];
            const keep = (chunk) => {
                for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) consoleTail.push(line);
                if (consoleTail.length > 300) consoleTail.splice(0, consoleTail.length - 300);
            };
            child.stdout.on('data', keep);
            child.stderr.on('data', keep);
            child.on('close', (code, signal) => {
                const current = server && server.child === child ? server : null;
                const reason = child.stopping;
                if (reason) debug.info('h3', 'ComfyUI stopped', { reason });
                else debug.error('h3', 'ComfyUI exited on its own', { code, signal, lastConsoleLines: consoleTail.slice(-30).join('\n') });
                if (current) { clearTimeout(current.idleTimer); server = null; }
            });
            const current = { child, port, key, external: false, idleTimer: null, consoleTail };
            debug.info('h3', 'starting ComfyUI', { python: install.python, dir: install.dir, port });
            current.ready = waitUntilUp(port, child).then(() => port);
            server = current;
            current.ready.catch((err) => { debug.error('h3', 'ComfyUI did not start', { error: err.message, lastConsoleLines: current.consoleTail.slice(-30).join('\n') }); if (server === current) stopServer('it failed to start'); });
        }
    }
    const current = server;
    const port = await current.ready;
    touchServer();
    return port;
}

// ─── ComfyUI HTTP ───────────────────────────────────────────────────
async function comfyJson(port, route, body) {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
        const error = new Error(describeValidationError(json) || `ComfyUI answered ${res.status}: ${text.slice(0, 300)}`);
        error.status = res.status;
        throw error;
    }
    return json;
}

function describeValidationError(json) {
    if (!json) return '';
    const nodeErrors = Object.values(json.node_errors || {});
    const first = nodeErrors[0];
    if (first) {
        const detail = (first.errors || []).map((e) => e.details || e.message).filter(Boolean).join('; ');
        return `${first.class_type}: ${detail || 'invalid input'}`;
    }
    return json.error?.message || '';
}

async function uploadImage(port, { name, bytes }) {
    const ext = path.extname(name || '').toLowerCase() || '.png';
    const form = new FormData();
    form.append('image', new Blob([Buffer.from(bytes)]), `h3-ref-${crypto.randomBytes(5).toString('hex')}${ext}`);
    form.append('overwrite', 'true');
    const res = await fetch(`http://127.0.0.1:${port}/upload/image`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Could not send a reference image to ComfyUI (${res.status}).`);
    return (await res.json()).name;
}

// ─── Generation ─────────────────────────────────────────────────────
let active = null; // { cancelled, cancel() }

/** Pull a displayable image out of a ComfyUI binary preview message (event 1 or 4). */
function previewDataUrl(buffer) {
    if (buffer.length < 12) return null;
    const jpeg = buffer.indexOf(Buffer.from([0xff, 0xd8, 0xff]), 4);
    const png = buffer.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 4);
    const useJpeg = jpeg !== -1 && (png === -1 || jpeg < png);
    const start = useJpeg ? jpeg : png;
    if (start === -1) return null;
    return `data:image/${useJpeg ? 'jpeg' : 'png'};base64,${buffer.subarray(start).toString('base64')}`;
}

/** Either a ready-made prompt (advanced), or references + a story that we turn into the structured H3 prompt. */
async function resolvePrompt(params, send) {
    if (params.rawPrompt && String(params.rawPrompt).trim()) return String(params.rawPrompt);
    const spec = params.spec || {};
    let story = String(spec.story || '');
    try {
        // Non-English stories are translated first; H3 understands English far better.
        const translated = await require('./localInference').translatePrompts({ prompt: story }, (data) => send({ type: 'status', phase: 'starting', message: data.message || 'Translating…' }));
        story = translated.params.prompt || story;
    } catch { /* no translator available — use the text as written */ }
    return composeH3Prompt({ ...spec, story });
}

async function generate(params, mainWindow) {
    if (active) throw new Error('An H3 generation is already running.');
    const install = inspectInstall();
    if (!install.ok) throw new Error(install.error || 'MiniMax H3 is not set up.');
    const images = (params.images || []).slice(0, MAX_REFERENCES).map((image) => {
        if (image.bytes || !image.path) return image;
        if (!fs.existsSync(image.path)) throw new Error(`A reference image is not available any more: ${image.path}`);
        return { name: image.name || path.basename(image.path), bytes: fs.readFileSync(image.path) };
    });
    if (!images.length) throw new Error('Add at least one reference image.');
    const wantsUpscale = !!params.upscale;
    if (wantsUpscale && !install.upscaler) throw new Error(`Upscale needs the H3 latent upscaler: ${install.upscalerHint}.`);

    const send = (data) => mainWindow?.webContents.send('h3:event', data);
    const run = { cancelled: false, cancel: () => {} };
    active = run;
    const seed = Number.isInteger(params.seed) && params.seed > 0 ? params.seed : crypto.randomInt(1, 2 ** 31 - 1);
    const runDir = path.join(RUNS_DIR, `${Date.now()}`);
    fs.mkdirSync(runDir, { recursive: true });
    let socket = null;
    let closingSocket = false;

    try {
        const prompt = await resolvePrompt(params, send);
        debug.info('h3', 'generation requested', {
            seconds: params.seconds, megapixels: params.megapixels, upscale: wantsUpscale, upscaleMegapixels: params.upscaleMegapixels,
            references: images.map((image, i) => ({ file: image.name, bytes: image.bytes?.length, ...(params.spec?.refs?.[i] || {}) })),
            seed, audio: params.audio !== 'off' ? (params.spec?.voices ? 'model decides, voices allowed' : 'effects only, no voices') : 'none', promptSent: prompt, gpu: await gpuSnapshot(),
        });
        send({ type: 'status', phase: 'starting', message: 'Starting ComfyUI…' });
        const port = await ensureServer(install);
        if (run.cancelled) throw new Error('Generation cancelled');

        send({ type: 'status', phase: 'uploading', message: 'Sending reference images…' });
        const names = [];
        for (const image of images) names.push(await uploadImage(port, image));

        const graph = buildH3Graph({
            prompt, images: names, seconds: params.seconds, megapixels: params.megapixels,
            upscaleMegapixels: wantsUpscale ? params.upscaleMegapixels : 0, seed, audio: params.audio !== 'off',
            ...(params.aspect > 0 ? { aspect: params.aspect } : {}),
        });
        const clientId = crypto.randomUUID();
        let promptId = null;
        let currentNode = null;
        let lastPreviewAt = 0;
        const outcome = new Promise((resolve, reject) => {
            const phaseOf = (node) => (node === NODE_BASE_SAMPLER ? 'base' : node === NODE_REFINE_SAMPLER ? 'refine' : null);
            miniWs.connect({
                port, path: `/ws?clientId=${clientId}`,
                onClose: () => {
                    if (closingSocket) return; // we closed it ourselves after the run
                    debug.error('h3', 'the connection to ComfyUI closed', { lastConsoleLines: (server?.consoleTail || []).slice(-30).join('\n') || '(ComfyUI was not started by this app)' });
                    reject(new Error('Lost the connection to ComfyUI. It may have run out of memory: open the Debug log (bug icon, top right) to see why.'));
                },
                onMessage: (message, binary) => {
                    if (binary) {
                        const now = Date.now();
                        if (now - lastPreviewAt < PREVIEW_MIN_INTERVAL_MS || !phaseOf(currentNode)) return;
                        const dataUrl = previewDataUrl(message);
                        if (dataUrl) { lastPreviewAt = now; send({ type: 'preview', phase: phaseOf(currentNode), dataUrl }); }
                        return;
                    }
                    let event;
                    try { event = JSON.parse(message); } catch { return; }
                    const data = event.data || {};
                    if (data.prompt_id && promptId && data.prompt_id !== promptId) return;
                    if (event.type === 'executing') {
                        if (data.node !== currentNode) debug.info('h3', 'ComfyUI node', { node: data.node, phase: phaseOf(data.node) || 'other' });
                        currentNode = data.node;
                        if (data.node === null && promptId) resolve();
                        else send({ type: 'status', phase: phaseOf(data.node) || 'working', message: phaseOf(data.node) ? '' : 'Loading models / decoding…' });
                    } else if (event.type === 'progress') {
                        const phase = phaseOf(data.node || currentNode);
                        if (phase) send({ type: 'progress', phase, value: data.value, max: data.max });
                    } else if (event.type === 'execution_interrupted') {
                        reject(new Error('Generation cancelled'));
                    } else if (event.type === 'execution_error') {
                        debug.error('h3', 'ComfyUI reported an error', { node: data.node_id, type: data.node_type, message: data.exception_message, traceback: (data.traceback || []).join('') });
                        reject(new Error(`${data.node_type || 'ComfyUI'}: ${data.exception_message || 'execution failed'}`.trim()));
                    }
                },
            }).then((handle) => { socket = handle; }).catch(reject);
        });
        outcome.catch(() => {}); // surfaced below; avoid an unhandled rejection while we queue

        // Wait for the socket before queueing so no early event is missed.
        for (let i = 0; i < 50 && !socket; i++) await new Promise((r) => setTimeout(r, 50));
        if (!socket) throw new Error('Could not open the ComfyUI event stream.');

        const queued = await comfyJson(port, '/prompt', { prompt: graph, client_id: clientId });
        promptId = queued.prompt_id;
        run.cancel = () => {
            comfyJson(port, '/interrupt', { prompt_id: promptId }).catch(() => {});
            comfyJson(port, '/queue', { delete: [promptId] }).catch(() => {});
        };
        if (run.cancelled) run.cancel();
        send({ type: 'status', phase: 'queued', message: 'Queued in ComfyUI…', seed });

        await outcome;
        const history = (await comfyJson(port, `/history/${promptId}`))[promptId];
        const video = history?.outputs?.[NODE_SAVE]?.images?.[0];
        if (!video) throw new Error('ComfyUI finished but returned no video.');
        const query = new URLSearchParams({ filename: video.filename, subfolder: video.subfolder || '', type: video.type || 'output' });
        const res = await fetch(`http://127.0.0.1:${port}/view?${query}`);
        if (!res.ok) throw new Error(`Could not fetch the video from ComfyUI (${res.status}).`);
        const filePath = path.join(runDir, 'video.mp4');
        fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
        send({ type: 'status', phase: 'done', message: 'Done' });
        debug.info('h3', 'video saved', { path: filePath, bytes: fs.statSync(filePath).size });
        return { url: pathToFileURL(filePath).href, mediaType: 'video', path: filePath, seed };
    } catch (err) {
        fs.rmSync(runDir, { recursive: true, force: true });
        if (run.cancelled) { debug.info('h3', 'cancelled by the user'); throw new Error('Generation cancelled'); }
        debug.error('h3', 'generation FAILED', { error: err.message });
        throw err;
    } finally {
        closingSocket = true;
        try { socket?.close(); } catch { /* already closed */ }
        if (active === run) active = null;
        touchServer();
    }
}

function cancelGeneration() {
    if (active) {
        active.cancelled = true;
        active.cancel();
    }
    return { ok: true };
}

// ─── IPC ─────────────────────────────────────────────────────────────
function getMainWindow() { return BrowserWindow.getAllWindows()[0] || null; }

function register() {
    ipcMain.handle('h3:get-config', () => ({ ...readConfig(), status: inspectInstall() }));
    ipcMain.handle('h3:set-config', (_, cfg) => {
        stopServer('the settings changed');
        writeConfig({ ...readConfig(), ...cfg });
        return { ...readConfig(), status: inspectInstall() };
    });
    ipcMain.handle('h3:pick-folder', async () => {
        const res = await dialog.showOpenDialog(getMainWindow(), { title: 'Select your ComfyUI folder (the one with main.py)', properties: ['openDirectory'] });
        return res.canceled ? null : res.filePaths[0];
    });
    ipcMain.handle('h3:status', () => inspectInstall());
    ipcMain.handle('h3:compose-prompt', (_, spec) => composeH3Prompt(spec));
    ipcMain.handle('h3:generate', (_, params) => generate(params, getMainWindow()));
    ipcMain.handle('h3:cancel', () => cancelGeneration());
    ipcMain.handle('h3:free-gpu', () => {
        if (active) throw new Error('Wait for the running generation to finish first.');
        stopServer('Free GPU memory was pressed');
        return { ok: true };
    });
    ipcMain.handle('h3:delete-output', (_, filePath) => {
        if (active) throw new Error('Wait for the running generation to finish first.');
        return outputStore.deleteRunContaining(RUNS_DIR, filePath);
    });
    // Re-open a saved result after a restart. Only files inside the runs folder are served.
    ipcMain.handle('h3:read-output', (_, filePath) => {
        const relative = path.relative(path.resolve(RUNS_DIR), path.resolve(String(filePath || '')));
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(filePath)) return null;
        return pathToFileURL(filePath).href;
    });
    app.on('before-quit', () => { cancelGeneration(); stopServer('the app is closing'); });
}

// Used by the movie maker's AI upscale: the same ComfyUI server, started on demand and shared with H3.
const bridge = {
    isBusy: () => !!active,
    inspect: () => inspectInstall(),
    async ensureServer() {
        const install = inspectInstall();
        if (!install.ok && !install.configured) throw new Error('ComfyUI is not set up: choose its folder in the Anime (H3) studio first.');
        if (!install.dir || !install.python) throw new Error('ComfyUI is not set up: choose its folder in the Anime (H3) studio first.');
        return ensureServer(install);
    },
    comfyJson,
    async upload(name, bytes) {
        const port = await bridge.ensureServer();
        return uploadImage(port, { name, bytes });
    },
    async view(port, entry) {
        const query = new URLSearchParams({ filename: entry.filename, subfolder: entry.subfolder || '', type: entry.type || 'output' });
        const res = await fetch(`http://127.0.0.1:${port}/view?${query}`);
        if (!res.ok) throw new Error(`Could not fetch a result from ComfyUI (${res.status}).`);
        return Buffer.from(await res.arrayBuffer());
    },
    /** Upscale models in ComfyUI's folder, read from disk (no need to start the server just to list them). */
    upscaleModelFiles() {
        const dir = inspectInstall().dir;
        if (!dir) return [];
        const found = [];
        const walk = (folder, prefix) => {
            let entries = [];
            try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (entry.isDirectory()) walk(path.join(folder, entry.name), `${prefix}${entry.name}/`);
                else if (/[.](pth|pt|safetensors|ckpt|bin)$/i.test(entry.name)) found.push(`${prefix}${entry.name}`);
            }
        };
        walk(path.join(dir, 'models', 'upscale_models'), '');
        return found;
    },
    touch: touchServer,
};

module.exports = { register, stop: () => stopServer('the app is closing'), inspectInstall, getRunsDir: () => RUNS_DIR, bridge, generate, cancelGeneration };
