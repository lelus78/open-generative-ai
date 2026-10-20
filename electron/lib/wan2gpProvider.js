// Wan2GP provider — video (and large image) models from https://github.com/deepbeepmeep/Wan2GP.
// We never bundle Python or weights; the user installs Wan2GP and picks one engine:
//
//   local  — the Wan2GP folder on this machine. Each generation runs
//            `wgp.py --process settings.json --output-dir <run>` (WanGP's headless
//            CLI mode, docs/CLI.md) and we parse its console for progress.
//   remote — WanGP's MCP server on another machine (docs/API.md → "MCP Server"),
//            `wgp.py --mcp --mcp-api-version 1 --mcp-transport streamable-http`.
//
// WanGP's Gradio UI is not an API: its ~700 endpoints are internal UI callbacks
// bound to browser state, so pointing the app at the Gradio port cannot work.

const { ipcMain, app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');
const { resolveLocalAiPaths } = require('./localInferencePaths');
const { withWan2gpAvailability } = require('./wan2gpModelAvailability');
const { WAN2GP_CATALOG, getModelById, buildWan2gpSettings } = require('./wan2gpCatalog');
const local = require('./wan2gpLocal');
const outputStore = require('./outputStore');
const { getHardwareProfile } = require('./hardwareProfile');
const { createMcpClient, normalizeMcpUrl } = require('./wan2gpMcp');

const CONFIG_DIR = path.join(app.getPath('userData'), 'local-ai');
const CONFIG_FILE = path.join(CONFIG_DIR, 'wan2gp.json');
const WORK_DIR = path.join(resolveLocalAiPaths({ userDataPath: app.getPath('userData') }).dataDir, 'wan2gp');
const INPUTS_DIR = path.join(WORK_DIR, 'inputs');
const RUNS_DIR = path.join(WORK_DIR, 'runs');
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm']);
// Smallest model in the catalog — used for the settings "Check" dry run.
const CHECK_MODEL = getModelById('wan2gp:wan21-t2v-1.3b');

// ─── Config ───────────────────────────────────────────────────────────────────
// { dir, python, url } — a Wan2GP folder takes precedence over a remote URL.
function readConfig() {
    try { return { dir: '', python: '', url: '', ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) }; }
    catch { return { dir: '', python: '', url: '' }; }
}
function writeConfig(cfg) {
    const next = {
        dir: (cfg.dir || '').trim(),
        python: (cfg.python || '').trim(),
        url: (cfg.url || '').trim().replace(/\/+$/, ''),
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
    return next;
}
function engineMode(cfg) {
    if (cfg.dir) return 'local';
    if (cfg.url) return 'remote';
    return null;
}

// ─── Remote (MCP) ─────────────────────────────────────────────────────────────
const mcpClients = new Map();
function mcpClientFor(url) {
    const endpoint = normalizeMcpUrl(url);
    if (!mcpClients.has(endpoint)) mcpClients.set(endpoint, createMcpClient(endpoint));
    return mcpClients.get(endpoint);
}

// Explain the most common misconfiguration: the URL of WanGP's Gradio UI.
async function explainRemoteFailure(url, err) {
    try {
        const res = await fetch(`${url.replace(/\/mcp$/, '')}/config`, { signal: AbortSignal.timeout(4000) });
        if (res.ok && (await res.json()).mode === 'blocks') {
            return 'This is the Wan2GP web UI (Gradio), which has no generation API. Start Wan2GP with '
                + '"python wgp.py --mcp --mcp-api-version 1 --mcp-transport streamable-http --mcp-host 0.0.0.0 --mcp-port 7866" '
                + 'and use http://<host>:7866/mcp — or set a local Wan2GP folder instead.';
        }
    } catch { /* not Gradio either */ }
    return `Wan2GP MCP server not reachable at ${normalizeMcpUrl(url)}: ${err.message}`;
}

async function probeRemote(url) {
    if (!url) return { ok: false, error: 'URL is empty' };
    try {
        const info = await mcpClientFor(url).probe();
        return { ok: true, mode: 'remote', message: `Connected to ${info.server} MCP ${info.version}` };
    } catch (err) {
        mcpClients.delete(normalizeMcpUrl(url));
        return { ok: false, mode: 'remote', error: await explainRemoteFailure(url, err) };
    }
}

// ─── Engine status ────────────────────────────────────────────────────────────
async function engineStatus(cfg = readConfig()) {
    const mode = engineMode(cfg);
    const modelTypes = WAN2GP_CATALOG.map(m => m.modelType);
    if (mode === 'local') {
        const install = local.resolveInstall(cfg);
        const check = local.checkInstall(install);
        if (!check.ok) return { ok: false, mode, error: check.error };
        return { ok: true, mode, modelStatus: local.localModelStatus(install, modelTypes) };
    }
    if (mode === 'remote') {
        const probe = await probeRemote(cfg.url);
        if (!probe.ok) return { ok: false, mode, error: probe.error };
        const client = mcpClientFor(cfg.url);
        const modelStatus = new Map();
        for (const modelType of modelTypes) {
            try { modelStatus.set(modelType, await client.modelAvailability(modelType)); }
            catch { /* leave unknown */ }
        }
        return { ok: true, mode, modelStatus };
    }
    return { ok: false, mode: null, error: 'Wan2GP is not configured — set its folder in Settings → Local Models.' };
}

async function listModels() {
    const engine = await engineStatus();
    if (engine.ok && engine.mode === 'local') {
        const install = local.resolveInstall(readConfig());
        engine.hardware = await getHardwareProfile(install?.ckptsDir);
    }
    return WAN2GP_CATALOG.map(m => withWan2gpAvailability(m, engine));
}

// Settings "Check": validates the folder + python with a `--dry-run`, or probes the MCP server.
// `quick` skips the dry run (it starts Python and imports torch — seconds, not milliseconds).
async function check(cfg) {
    const mode = engineMode(cfg);
    if (mode === 'remote') return probeRemote(cfg.url);
    if (mode !== 'local') return { ok: false, error: 'Set the Wan2GP folder or a server URL first.' };

    const install = local.resolveInstall(cfg);
    const installCheck = local.checkInstall(install);
    if (!installCheck.ok) return { ok: false, mode, error: installCheck.error };
    if (cfg.quick) return { ok: true, mode, message: `Wan2GP folder found · python ${install.python}` };
    const settings = buildWan2gpSettings(CHECK_MODEL, { prompt: 'dry run', aspect_ratio: '16:9', seed: 1 });
    const result = await local.dryRun({ install, settings, runDir: path.join(WORK_DIR, 'check') });
    return result.ok
        ? { ok: true, mode, message: `Wan2GP found · python ${install.python}` }
        : { ok: false, mode, error: result.message };
}

// ─── Inputs ───────────────────────────────────────────────────────────────────
// Start frames are stored locally; local runs pass the path to Wan2GP, remote
// runs upload the file to the MCP server at generation time.
function saveInput({ name, type, bytes }) {
    if (!bytes || !bytes.length) throw new Error('Empty file payload');
    fs.mkdirSync(INPUTS_DIR, { recursive: true });
    const ext = path.extname(name || '') || (type === 'image/jpeg' ? '.jpg' : '.png');
    const filePath = path.join(INPUTS_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext.toLowerCase()}`);
    fs.writeFileSync(filePath, Buffer.from(bytes));
    return { url: pathToFileURL(filePath).href, path: filePath };
}

function inputPath(file) {
    if (!file) return null;
    const filePath = String(file).startsWith('file:') ? fileURLToPath(file) : String(file);
    if (!path.isAbsolute(filePath) || !fs.existsSync(filePath)) {
        throw new Error('An input file is not available on this machine — upload it again.');
    }
    return filePath;
}

// ─── Generation ───────────────────────────────────────────────────────────────
let active = null; // { cancel: () => void, cancelled: boolean }

const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function mediaResult(filePath, seed) {
    const ext = path.extname(filePath).toLowerCase();
    const mediaType = VIDEO_EXTENSIONS.has(ext) ? 'video' : 'image';
    // Images come back inline (like sd.cpp results) so the UI can copy/download them: fetch() cannot
    // read file:// URLs. Videos are too big for that and play fine from their file URL.
    const url = mediaType === 'image' && IMAGE_MIME[ext]
        ? `data:${IMAGE_MIME[ext]};base64,${fs.readFileSync(filePath).toString('base64')}`
        : pathToFileURL(filePath).href;
    return { url, mediaType, seed, path: filePath };
}

async function generate(params, mainWindow) {
    if (active) throw new Error('A Wan2GP generation is already running.');
    const model = getModelById(params.model);
    if (!model) throw new Error(`Unknown Wan2GP model: ${params.model}`);

    const cfg = readConfig();
    const mode = engineMode(cfg);
    if (!mode) throw new Error('Wan2GP is not configured — set its folder in Settings → Local Models.');

    const send = (data) => mainWindow?.webContents.send('local-ai:progress', data);
    const imagePath = inputPath(params.image);
    const audioPath = inputPath(params.audio);
    const runDir = path.join(RUNS_DIR, `${Date.now()}`);
    fs.mkdirSync(runDir, { recursive: true });
    const run = { cancelled: false, cancel: () => {} };
    active = run;
    send({ status: 'starting', progress: 0 });

    try {
        // Non-English prompts are translated first (English works much better with these models).
        const translated = await require('./localInference').translatePrompts(params, send);
        params = translated.params;

        if (mode === 'local') {
            const install = local.resolveInstall(cfg);
            const installCheck = local.checkInstall(install);
            if (!installCheck.ok) throw new Error(installCheck.error);
            const settings = buildWan2gpSettings(model, params, { imageStart: imagePath, audioStart: audioPath });
            const { child, done } = local.runGeneration({ install, settings, runDir, onProgress: send });
            run.cancel = () => local.killTree(child);
            const mediaPath = await done.catch((err) => {
                throw run.cancelled ? new Error('Generation cancelled') : err;
            });
            send({ status: 'done', progress: 1 });
            return { ...mediaResult(mediaPath, settings.seed), translatedPrompt: translated.translatedPrompt };
        }

        if (model.needsAudio) throw new Error(`${model.name} needs a local Wan2GP folder: audio files cannot be sent to a remote server yet.`);
        const client = mcpClientFor(cfg.url);
        const abort = new AbortController();
        let jobId = null;
        run.cancel = () => {
            abort.abort();
            client.cancel(jobId).catch(() => {});
        };
        const imageStart = imagePath
            ? await client.uploadImage({ name: path.basename(imagePath), bytes: fs.readFileSync(imagePath) })
            : undefined;
        const settings = buildWan2gpSettings(model, params, { imageStart });
        const item = await client.generate(settings, {
            onProgress: send,
            onJobId: (id) => { jobId = id; },
            signal: abort.signal,
        });
        const { filename, bytes } = await client.download(item.media_id);
        const mediaPath = path.join(runDir, path.basename(filename || `${item.media_id.replace(/\W/g, '_')}.mp4`));
        fs.writeFileSync(mediaPath, bytes);
        send({ status: 'done', progress: 1 });
        return mediaResult(mediaPath, settings.seed);
    } catch (err) {
        if (run.cancelled) throw new Error('Generation cancelled');
        throw err;
    } finally {
        if (active === run) active = null;
    }
}

function cancelGeneration() {
    if (active) {
        active.cancelled = true;
        active.cancel();
    }
    return { ok: true };
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
function getMainWindow() { return BrowserWindow.getAllWindows()[0] || null; }

function register() {
    ipcMain.handle('wan2gp:get-config', () => {
        const cfg = readConfig();
        return { ...cfg, mode: engineMode(cfg), defaultPython: cfg.dir ? local.defaultPythonPath(cfg.dir) : '' };
    });
    ipcMain.handle('wan2gp:set-config', (_, cfg) => {
        mcpClients.clear();
        return { ok: true, config: writeConfig({ ...readConfig(), ...cfg }) };
    });
    ipcMain.handle('wan2gp:set-url', (_, url) => {
        mcpClients.clear();
        writeConfig({ ...readConfig(), url });
        return { ok: true };
    });
    ipcMain.handle('wan2gp:install', async () => {
        const { installWan2gp } = require('./wan2gpInstaller');
        const { downloadFile, getDataDir } = require('./localInference');
        const send = (data) => getMainWindow()?.webContents.send('local-ai:download-progress', { id: 'wan2gp-install', ...data });
        send({ phase: 'installing', message: 'Starting…' });
        try {
            const { dir } = await installWan2gp({ dataDir: getDataDir(), downloadFile, send });
            mcpClients.clear();
            writeConfig({ ...readConfig(), dir, python: '' });
            send({ phase: 'done', progress: 1 });
            return { ok: true, dir };
        } catch (err) {
            send({ phase: 'error', error: err.message });
            throw err;
        }
    });
    ipcMain.handle('local-ai:hardware', async () => {
        const install = local.resolveInstall(readConfig());
        return getHardwareProfile(install?.ckptsDir || app.getPath('userData'));
    });
    // Generated files: delete one result, show the space used, or clear everything.
    ipcMain.handle('wan2gp:delete-output', (_, filePath) => {
        if (active) throw new Error('Wait for the running generation to finish first.');
        return outputStore.deleteRunContaining(RUNS_DIR, filePath);
    });
    ipcMain.handle('wan2gp:storage-usage', () => outputStore.usage({ runsDir: RUNS_DIR, inputsDir: INPUTS_DIR }));
    ipcMain.handle('wan2gp:clear-outputs', () => {
        if (active) throw new Error('Wait for the running generation to finish first.');
        return outputStore.clearAll({ runsDir: RUNS_DIR, inputsDir: INPUTS_DIR });
    });
    ipcMain.handle('wan2gp:check', (_, cfg) => check({ ...readConfig(), ...cfg }));
    ipcMain.handle('wan2gp:probe', (_, url) => probeRemote(url));
    ipcMain.handle('wan2gp:pick-folder', async () => {
        const res = await dialog.showOpenDialog(getMainWindow(), { title: 'Select the Wan2GP folder', properties: ['openDirectory'] });
        return res.canceled ? null : res.filePaths[0];
    });
    ipcMain.handle('wan2gp:list-models', () => listModels());
    ipcMain.handle('wan2gp:generate', (_, params) => generate(params, getMainWindow()));
    ipcMain.handle('wan2gp:cancel-generation', () => cancelGeneration());
    ipcMain.handle('wan2gp:upload-file', (_, payload) => saveInput(payload));

    // Never leave a detached wgp.py running after the app quits.
    app.on('before-quit', () => cancelGeneration());
}

module.exports = { register, WAN2GP_CATALOG };
