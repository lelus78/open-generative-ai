// Wires the MCP server into the app: settings (off by default), the engines behind the tools, and
// the events that let the interface show what an assistant is doing.
const { app, ipcMain, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createHandler, start } = require('./mcpServer');
const { createTools } = require('./mcpTools');
const { createMediaTools, createJobs, jobInfo, buildMovieProject, buildInterfaceProject } = require('./mcpMedia');
const { INSTRUCTIONS, PROMPTS } = require('./mcpGuide');
const reel = require('./reelDirector');
const { shared: debug, formatEntries } = require('./debugLog');
const outputStore = require('./outputStore');

const DEFAULT_PORT = 47821;
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'mcp-control.json');

let server = null;
let startError = null;
const jobs = createJobs(); // kept across server restarts, so a long job is not lost when the setting is toggled

function readSettings() {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf-8')); } catch { /* first run */ }
    const settings = {
        enabled: !!saved.enabled,
        port: Number.isInteger(saved.port) && saved.port > 1023 && saved.port < 65536 ? saved.port : DEFAULT_PORT,
        token: typeof saved.token === 'string' && saved.token.length >= 32 ? saved.token : crypto.randomBytes(24).toString('hex'),
    };
    if (saved.token !== settings.token || saved.enabled !== settings.enabled || saved.port !== settings.port) writeSettings(settings);
    return settings;
}

function writeSettings(settings) {
    fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
}

const getMainWindow = () => BrowserWindow.getAllWindows()[0] || null;

/**
 * The main window as the engines see it: everything still reaches the interface, and the progress events
 * also feed the job that is running, so job_status and the app can say how far it is and how long is left.
 */
function progressWindow() {
    const report = (update) => jobs.report('gpu', update);
    return {
        webContents: {
            send: (channel, data) => {
                getMainWindow()?.webContents.send(channel, data);
                if (!data) return;
                if (channel === 'local-ai:progress') report({ fraction: data.progress, phase: data.status, message: data.message });
                else if (channel === 'h3:event' && data.type === 'progress' && data.max) report({ fraction: data.value / data.max, phase: data.phase });
                else if (channel === 'h3:event' && data.type === 'status') report({ phase: data.phase, message: data.message });
            },
        },
    };
}

// The app shows the assistant's jobs live (src/lib/externalResults.js); a burst of progress events is sent once.
let jobsTimer = null;
function pushJobs() {
    if (jobsTimer) return;
    jobsTimer = setTimeout(() => {
        jobsTimer = null;
        getMainWindow()?.webContents.send('local-ai:external', { phase: 'jobs', jobs: jobsForApp() });
    }, 250);
}
const jobsForApp = () => jobs.list().slice(0, 20).map((j) => ({ ...jobInfo(j), finished_at: j.finishedAt }));
jobs.onChange(pushJobs);

/** A photo, small, as raw pixels: enough to tell a sharp, colourful photo from a dull one. */
function decodeSmall(file) {
    const image = nativeImage.createFromPath(file);
    if (image.isEmpty()) throw new Error(`Cannot read ${file}`);
    const small = image.resize({ width: 256 });
    const { width, height } = small.getSize();
    return { data: small.toBitmap(), width, height };
}
const analysePhotos = async (paths) => reel.analysePhotos(paths, { decode: decodeSmall });

/** One list of local models from both engines, in the shape the tools expect. */
async function listModels() {
    const sd = require('./localInference');
    const wan2gp = require('./wan2gpProvider');
    const [sdModels, wanModels] = await Promise.all([sd.listModels().catch(() => []), wan2gp.listModels().catch(() => [])]);

    const fromSd = sdModels.map(m => {
        const downloaded = m.state === 'downloaded';
        const unfit = m.fit === 'unfit';
        return {
            id: m.id, name: m.name, engine: 'sd.cpp', kind: 'image', fit: m.fit, legacy: !!m.legacy,
            downloaded,
            ready: downloaded && !unfit,
            reason: unfit ? m.fitReason : (!downloaded ? 'not downloaded — download it in Settings → Local Models' : ''),
        };
    });
    const fromWan = wanModels.map(m => ({
        id: m.id, name: m.name, engine: 'Wan2GP', fit: m.fit, legacy: !!m.legacy,
        kind: m.lipsync ? 'lipsync' : m.type === 'video' ? 'video' : m.type === 'audio' ? 'audio' : m.edit ? 'edit' : 'image',
        downloaded: !!m.downloaded,
        ready: !!m.ready && !!m.downloaded,
        reason: m.unavailableReason || (m.ready && !m.downloaded ? 'not downloaded yet — generate once from the app (or download it in Settings) first' : ''),
    }));
    return [...fromSd, ...fromWan];
}

function buildDeps() {
    const sd = require('./localInference');
    const wan2gp = require('./wan2gpProvider');
    return {
        listModels,
        generate: (params) => (String(params.model).startsWith('wan2gp:')
            ? wan2gp.generate(params, progressWindow())
            : sd.generate(params, progressWindow())),
        enhance: (text, kind) => sd.enhancePrompt(text, kind),
        cancel: () => {
            try { sd.cancelGeneration(); } catch { /* idle */ }
            try { wan2gp.cancelGeneration(); } catch { /* idle */ }
            try { require('./comfyH3').cancelGeneration(); } catch { /* idle */ }
        },
        recent: (limit) => outputStore.recentResults(wan2gp.getRunsDir(), limit),
        notify: (event) => getMainWindow()?.webContents.send('local-ai:external', event),
    };
}


/** What the media tools need: the engines of the video studios, MiniMax H3 and the movie maker, run without the interface. */
function buildMediaDeps(deps) {
    const comfy = require('./comfyH3');
    const movie = require('./movieMaker').engine;
    const sd = require('./localInference');
    return {
        jobs,
        listModels: deps.listModels,
        generate: deps.generate,
        notify: deps.notify,
        cancelEngines: deps.cancel,
        h3: (params) => comfy.generate(params, progressWindow()),
        reelAnalyse: analysePhotos,
        storyboard: (request) => sd.storyboard(request, (message) => deps.notify({ phase: 'status', message })),
        movie: { ...movie, cancel: () => movie.cancel() },
        movieStatus: async () => {
            const ffmpeg = movie.findFfmpeg();
            const h3 = comfy.inspectInstall();
            return `ffmpeg ${ffmpeg.ok ? ffmpeg.version || 'found' : 'MISSING'}; MiniMax H3 ${h3.ok ? 'ready' : `not ready (${h3.error || 'not set up'})`}; H3 sharper pass ${h3.upscaler ? 'available' : 'not installed'}`;
        },
        openFolder: (kind) => require('./outputFolders').openFolder(kind),
        debugLog: ({ lines, level, search }) => {
            let entries = debug.entries();
            if (level === 'warn') entries = entries.filter((e) => e.level !== 'info');
            if (level === 'error') entries = entries.filter((e) => e.level === 'error');
            if (search) { const needle = search.toLowerCase(); entries = entries.filter((e) => `${e.scope} ${e.message} ${JSON.stringify(e.data || '')}`.toLowerCase().includes(needle)); }
            return formatEntries(entries.slice(-lines));
        },
    };
}

async function startServer(settings) {
    await stopServer();
    startError = null;
    const deps = { ...buildDeps(), jobs };
    const handle = createHandler({
        name: 'open-generative-ai', version: app.getVersion(), instructions: INSTRUCTIONS, prompts: PROMPTS,
        tools: [...createTools(deps), ...createMediaTools(buildMediaDeps(deps))],
    });
    try {
        server = await start({ port: settings.port, token: settings.token, handle });
    } catch (err) {
        server = null;
        startError = err.code === 'EADDRINUSE' ? `Port ${settings.port} is already in use.` : err.message;
    }
}

function stopServer() {
    return new Promise((resolve) => {
        if (!server) return resolve();
        const closing = server;
        server = null;
        closing.close(() => resolve());
        closing.closeAllConnections?.();
    });
}

function status(settings = readSettings()) {
    const url = `http://127.0.0.1:${settings.port}/mcp`;
    return {
        enabled: settings.enabled,
        running: !!server,
        error: startError,
        port: settings.port,
        url,
        token: settings.token,
        command: `claude mcp add --transport http open-generative-ai ${url} --header "Authorization: Bearer ${settings.token}"`,
    };
}

function register() {
    ipcMain.handle('mcp:get', () => status());
    ipcMain.handle('mcp:set', async (_, patch = {}) => {
        const current = readSettings();
        const next = {
            ...current,
            ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
            ...(patch.regenerateToken ? { token: crypto.randomBytes(24).toString('hex') } : {}),
        };
        writeSettings(next);
        if (next.enabled) await startServer(next); else { await stopServer(); startError = null; }
        return status(next);
    });
    ipcMain.handle('mcp:jobs', () => jobsForApp());
    ipcMain.handle('mcp:cancel-job', (_, id) => { const job = jobs.get(id); return job ? jobs.cancel(job) : false; });

    // The Reel preset of the Movie tab: the same plan as the movie_reel tool, as a project for the interface.
    ipcMain.handle('movie:reel-plan', async (_, request = {}) => {
        const paths = (request.photos || []).map(String);
        const faces = new Set((request.faces || []).map((f) => String(f).toLowerCase()));
        const photos = (await analysePhotos(paths)).map((p) => ({ ...p, faces: faces.has(p.path.toLowerCase()) }));
        const plan = reel.planReel({ photos, variant: request.variant, goal: request.goal, texts: request.texts || {} });
        const project = buildMovieProject(plan, { options: require('./movieMaker').engine.movieOptions() });
        return { plan, project: buildInterfaceProject(project) };
    });

    const settings = readSettings();
    if (settings.enabled) startServer(settings).catch((err) => console.error('[mcp] could not start:', err));
    app.on('before-quit', () => { stopServer(); });
}

module.exports = { register, listModels };
