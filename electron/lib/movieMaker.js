// Movie maker: joins the clips and pictures made by the local studios into one finished movie
// (transitions, music, captions) with ffmpeg — everything stays on this machine.

const { ipcMain, app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { resolveLocalAiPaths } = require('./localInferencePaths');
const outputStore = require('./outputStore');
const { buildMovieArgs, buildTitleExportArgs, parseProgress, parseProbe, captionFileText, TRANSITION_LIST, TITLE_STYLES, CAPTION_STYLES } = require('./movieFilter');
const { shared: debug } = require('./debugLog');
const upscaler = require('./movieUpscale');

const CONFIG_DIR = path.join(app.getPath('userData'), 'local-ai');
const DATA_DIR = resolveLocalAiPaths({ userDataPath: app.getPath('userData') }).dataDir;
const MOVIES_DIR = path.join(DATA_DIR, 'movies');
const IMPORTS_DIR = path.join(MOVIES_DIR, 'imports');
const WAN2GP_RUNS = path.join(DATA_DIR, 'wan2gp', 'runs');
const H3_RUNS = path.join(DATA_DIR, 'comfy-h3', 'runs');
const MEDIA_FILTERS = {
    video: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'] }],
    image: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    audio: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] }],
};
const ALLOWED_EXT = /\.(mp4|mov|mkv|webm|avi|png|jpe?g|webp|mp3|wav|m4a|aac|flac|ogg)$/i;
// Font files per role, first one that exists wins. Missing roles fall back to the bold sans font.
const FONT_CANDIDATES = {
    bold: ['C:/Windows/Fonts/arialbd.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf'],
    sans: ['C:/Windows/Fonts/arial.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf'],
    serif: ['C:/Windows/Fonts/georgia.ttf', 'C:/Windows/Fonts/times.ttf', '/System/Library/Fonts/Supplemental/Times New Roman.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'],
    serifBold: ['C:/Windows/Fonts/georgiab.ttf', 'C:/Windows/Fonts/timesbd.ttf', '/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'],
    impact: ['C:/Windows/Fonts/impact.ttf', '/System/Library/Fonts/Supplemental/Impact.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
    mono: ['C:/Windows/Fonts/consola.ttf', '/System/Library/Fonts/Menlo.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'],
};
function findFonts() {
    const fonts = {};
    for (const [role, list] of Object.entries(FONT_CANDIDATES)) {
        const found = list.find((f) => fs.existsSync(f));
        if (found) fonts[role] = found;
    }
    return fonts;
}

fs.mkdirSync(IMPORTS_DIR, { recursive: true });

// ─── ffmpeg lookup ─────────────────────────────────────────────────────────────
// Wan2GP ships a recent ffmpeg (the transitions need 4.3+; older system builds lack xfade).
let ffmpegCache;
function ffmpegVersion(bin) {
    const res = spawnSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    if (res.error || res.status !== 0) return null;
    const m = /ffmpeg version\s+n?(\d+)\.(\d+)/.exec(res.stdout || '');
    return m ? Number(m[1]) + Number(m[2]) / 100 : 0;
}
function candidateBinaries() {
    const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const list = [];
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'wan2gp.json'), 'utf8'));
        if (cfg.dir) {
            list.push(path.join(cfg.dir, 'ffmpeg_bins', exe), path.join(cfg.dir, exe));
            try {
                for (const name of fs.readdirSync(cfg.dir)) {
                    if (/^ffmpeg/i.test(name)) list.push(path.join(cfg.dir, name, 'bin', exe));
                }
            } catch { /* folder unreadable */ }
        }
    } catch { /* Wan2GP not configured */ }
    list.push(path.join(DATA_DIR, 'tools', 'ffmpeg', exe), process.env.FFMPEG_PATH || '', exe);
    return list.filter(Boolean);
}
function findFfmpeg(refresh = false) {
    if (ffmpegCache && !refresh) return ffmpegCache;
    let best = null;
    for (const bin of candidateBinaries()) {
        if (path.isAbsolute(bin) && !fs.existsSync(bin)) continue;
        const version = ffmpegVersion(bin);
        if (version == null) continue;
        if (!best || version > best.version) best = { bin, version };
        if (version >= 5) break;
    }
    ffmpegCache = best ? { ...best, ok: best.version >= 4.03 } : { ok: false, bin: null, version: 0 };
    return ffmpegCache;
}
function requireFfmpeg() {
    const found = findFfmpeg();
    if (!found.bin) throw new Error('ffmpeg was not found. Install Wan2GP (it brings ffmpeg) or put ffmpeg.exe in local-ai/tools/ffmpeg.');
    if (!found.ok) throw new Error(`The ffmpeg found (${found.bin}) is too old for transitions (need 4.3+).`);
    return found.bin;
}

// ─── Probe ─────────────────────────────────────────────────────────────────────
function probeFile(file) {
    const bin = requireFfmpeg();
    const res = spawnSync(bin, ['-hide_banner', '-i', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return { path: file, ...parseProbe(`${res.stderr || ''}${res.stdout || ''}`) };
}

function checkMediaPath(file) {
    const full = path.resolve(String(file || ''));
    if (!ALLOWED_EXT.test(full) || !fs.existsSync(full)) throw new Error(`File not available: ${file}`);
    return full;
}

// ─── Render ────────────────────────────────────────────────────────────────────
let active = null;
const rendering = () => !!active;

function send(channel, data) {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, data);
}

async function render(project) {
    if (active) throw new Error('A movie is already being rendered.');
    const bin = requireFfmpeg();
    const run = { cancelled: false, child: null };
    active = run;
    const runDir = path.join(MOVIES_DIR, String(Date.now()));
    fs.mkdirSync(runDir, { recursive: true });
    const isPreview = project.quality === 'preview';
    const outPath = path.join(runDir, isPreview ? 'preview.mp4' : 'movie.mp4');
    if (isPreview) {
        // Only the latest preview is kept.
        try {
            for (const name of fs.readdirSync(MOVIES_DIR)) {
                const old = path.join(MOVIES_DIR, name);
                if (old !== runDir && fs.existsSync(path.join(old, 'preview.mp4'))) fs.rmSync(old, { recursive: true, force: true });
            }
        } catch { /* nothing to clean */ }
    }
    try {
        const clips = [];
        for (const [index, input] of (project.clips || []).entries()) {
            const clip = { ...input };
            const textFile = (name, text) => { const f = path.join(runDir, `${name}-${index}.txt`); fs.writeFileSync(f, captionFileText(text)); return f; };
            if (String(clip.caption || '').trim()) clip.captionFile = textFile('caption', clip.caption);
            if (String(clip.title || '').trim()) clip.titleFile = textFile('title', clip.title);
            if (String(clip.subtitle || '').trim()) clip.subtitleFile = textFile('subtitle', clip.subtitle);
            if (clip.sfx?.path) clip.sfx = { ...clip.sfx, path: checkMediaPath(clip.sfx.path) };
            else delete clip.sfx;
            if (clip.kind === 'title') { clips.push({ ...clip, path: '', duration: Number(clip.duration) || 3 }); continue; }
            const file = checkMediaPath(input.path);
            const isImage = /\.(png|jpe?g|webp)$/i.test(file);
            if (isImage) { clips.push({ ...clip, path: file, kind: 'image', duration: Number(clip.duration) || 4 }); continue; }
            const info = probeFile(file);
            if (!info.hasVideo || !info.duration) throw new Error(`Cannot read the video: ${path.basename(file)}`);
            clips.push({ ...clip, path: file, kind: 'video', duration: info.duration, hasAudio: info.hasAudio });
        }
        const music = project.music?.path ? { ...project.music, path: checkMediaPath(project.music.path) } : undefined;
        const fonts = findFonts();
        const fontFile = fonts.bold || fonts.sans;
        // Quick preview: half size, fast encode — to check the cut while editing.
        const preview = project.quality === 'preview';
        const size = preview ? { width: Math.max(320, Math.round((Number(project.width) || 1280) / 2)), height: Math.max(180, Math.round((Number(project.height) || 720) / 2)), crf: 30 } : {};
        const plan = buildMovieArgs({ ...project, ...size, preview, clips, music, fontFile, fonts }, outPath);
        debug.info('movie', 'render started', { clips: clips.length, seconds: plan.totalSeconds, size: `${plan.width}x${plan.height}`, transition: project.transition, music: !!music });
        send('movie:event', { type: 'status', message: 'Rendering…', progress: 0 });

        await new Promise((resolve, reject) => {
            const child = spawn(bin, plan.args, { windowsHide: true });
            run.child = child;
            let tail = '';
            let lastSent = 0;
            child.stdout.on('data', (d) => {
                const fraction = parseProgress(d.toString(), plan.totalSeconds);
                const now = Date.now();
                if (fraction != null && now - lastSent > 250) { lastSent = now; send('movie:event', { type: 'progress', progress: fraction }); }
            });
            child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-4000); });
            child.on('error', (err) => reject(new Error(`Could not start ffmpeg: ${err.message}`)));
            child.on('close', (code) => {
                if (run.cancelled) return reject(new Error('Rendering cancelled'));
                if (code === 0 && fs.existsSync(outPath)) return resolve();
                debug.error('movie', 'ffmpeg failed', { code, log: tail, args: plan.args.join(' ') });
                reject(new Error(`ffmpeg failed (code ${code}).\n${tail.split('\n').slice(-6).join('\n')}`));
            });
        });
        send('movie:event', { type: 'progress', progress: 1 });
        const bytes = fs.statSync(outPath).size;
        debug.info('movie', 'movie saved', { path: outPath, bytes });
        return { path: outPath, url: pathToFileURL(outPath).href, seconds: plan.totalSeconds, bytes, width: plan.width, height: plan.height };
    } catch (err) {
        fs.rmSync(runDir, { recursive: true, force: true });
        if (run.cancelled) throw new Error('Rendering cancelled');
        debug.error('movie', 'render FAILED', { error: err.message });
        throw err;
    } finally {
        if (active === run) active = null;
    }
}

function cancel() {
    if (active) {
        active.cancelled = true;
        try {
            if (process.platform === 'win32') spawn('taskkill', ['/pid', String(active.child.pid), '/T', '/F'], { stdio: 'ignore' });
            else active.child.kill('SIGTERM');
        } catch { /* already gone */ }
    }
    return { ok: true };
}

// ─── Library: everything made so far that can go into a movie ───────────────────
function library() {
    const items = [];
    const add = (dir, source, limit) => {
        for (const f of outputStore.recentResults(dir, limit)) {
            if (!/\.(mp4|webm|mkv|mov)$/i.test(f.path)) continue;
            items.push({ ...f, source, url: pathToFileURL(f.path).href });
        }
    };
    add(WAN2GP_RUNS, 'Video', 60);
    add(H3_RUNS, 'Anime', 40);
    try {
        for (const name of fs.readdirSync(MOVIES_DIR)) {
            const file = path.join(MOVIES_DIR, name, 'movie.mp4');
            if (fs.existsSync(file)) items.push({ path: file, source: 'Movie', modifiedAt: new Date(fs.statSync(file).mtimeMs).toISOString(), url: pathToFileURL(file).href });
        }
    } catch { /* nothing yet */ }
    return items.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
}

function importBytes({ name, type, bytes }) {
    if (!bytes || !bytes.length) throw new Error('Empty file');
    const ext = path.extname(name || '').toLowerCase() || (type === 'image/jpeg' ? '.jpg' : '.png');
    const file = path.join(IMPORTS_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}${ext}`);
    fs.writeFileSync(file, Buffer.from(bytes));
    return { path: file, url: pathToFileURL(file).href };
}

function readableUrl(file) {
    const full = path.resolve(String(file || ''));
    if (!ALLOWED_EXT.test(full) || !fs.existsSync(full)) return null;
    return pathToFileURL(full).href;
}

// A title on a transparent background saved as a video with alpha (ProRes 4444 .mov or VP9 .webm).
async function exportTitle(params) {
    const bin = requireFfmpeg();
    const format = params.format === 'webm' ? 'webm' : 'mov';
    const dir = path.join(MOVIES_DIR, `title-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    try {
        const textFile = (name, text) => { const f = path.join(dir, `${name}.txt`); fs.writeFileSync(f, captionFileText(text)); return f; };
        const clip = { title: params.title, titleStyle: params.titleStyle, titleColor: params.titleColor, titleSize: params.titleSize };
        if (String(params.title || '').trim()) clip.titleFile = textFile('title', params.title);
        if (String(params.subtitle || '').trim()) clip.subtitleFile = textFile('subtitle', params.subtitle);
        const fonts = findFonts();
        const out = path.join(dir, `title.${format}`);
        const plan = buildTitleExportArgs({ clip, width: params.width, height: params.height, fps: params.fps, seconds: params.seconds, format, fonts, fontFile: fonts.bold || fonts.sans }, out);
        const res = spawnSync(bin, plan.args, { encoding: 'utf8', windowsHide: true, timeout: 120000 });
        if (res.status !== 0 || !fs.existsSync(out)) throw new Error(`Could not make the title: ${(res.stderr || '').trim().split(String.fromCharCode(10)).slice(-3).join(' ')}`);
        const pick = await dialog.showSaveDialog(BrowserWindow.getAllWindows()[0] || null, {
            title: 'Save the transparent title',
            defaultPath: path.join(app.getPath('videos'), `title.${format}`),
            filters: [{ name: format === 'webm' ? 'WebM with alpha' : 'ProRes 4444 with alpha', extensions: [format] }],
        });
        if (pick.canceled || !pick.filePath) return null;
        fs.copyFileSync(out, pick.filePath);
        debug.info('movie', 'transparent title saved', { path: pick.filePath, format });
        return pick.filePath;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// The last frame of a clip, saved as a picture (used as the look reference of the next shot).
function lastFrame(file) {
    const bin = requireFfmpeg();
    const full = checkMediaPath(file);
    const out = path.join(IMPORTS_DIR, `last-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`);
    const res = spawnSync(bin, ['-y', '-hide_banner', '-loglevel', 'error', '-sseof', '-0.2', '-i', full, '-frames:v', '1', '-update', '1', out], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (res.status !== 0 || !fs.existsSync(out)) throw new Error(`Could not take the last frame: ${(res.stderr || '').trim().slice(-200)}`);
    return { path: out, url: pathToFileURL(out).href };
}

// ─── Final upscale ──────────────────────────────────────────────────────────────
let upscaling = null;

async function upscale({ input, target = '1080p', method = 'fast', model = '', strength = 0.4 }) {
    if (upscaling) throw new Error('An upscale is already running.');
    if (rendering()) throw new Error('Wait for the movie to finish rendering.');
    const bin = requireFfmpeg();
    const file = checkMediaPath(input);
    const run = { cancelled: false, child: null, interrupt: { current: null } };
    upscaling = run;
    const runDir = path.join(MOVIES_DIR, `${Date.now()}`);
    fs.mkdirSync(runDir, { recursive: true });
    const output = path.join(runDir, 'movie.mp4');
    const send = (data) => { for (const win of BrowserWindow.getAllWindows()) win.webContents.send('movie:event', data); };
    try {
        const src = await upscaler.probeSize(bin, file);
        const size = upscaler.targetSize(src.width, src.height, target);
        debug.info('movie', 'upscale started', { method, target, from: `${src.width}x${src.height}`, to: `${size.width}x${size.height}`, model });
        const common = { bin, input: file, output, size, send, isCancelled: () => run.cancelled, setChild: (c) => { run.child = c; } };
        if (method === 'ai') {
            const comfy = require('./comfyH3').bridge;
            if (comfy.isBusy()) throw new Error('An H3 video is being made: wait for it to finish, or use the fast upscale.');
            const models = comfy.upscaleModelFiles();
            const chosen = model && models.includes(model) ? model : models.find((m) => /esrgan/i.test(m) && !/ultrasharp/i.test(m)) || models[0];
            if (!chosen) throw new Error('ComfyUI has no upscale model (put one in ComfyUI/models/upscale_models).');
            await upscaler.upscaleAi({ ...common, model: chosen, strength: Number(strength), comfy, workDir: runDir, interrupt: run.interrupt });
            comfy.touch();
        } else {
            await upscaler.upscaleFast(common);
        }
        const bytes = fs.statSync(output).size;
        send({ type: 'progress', progress: 1 });
        debug.info('movie', 'upscale finished', { path: output, bytes });
        for (const leftover of ['pieces', 'upscaled', 'list.txt']) fs.rmSync(path.join(runDir, leftover), { recursive: true, force: true });
        return { path: output, url: pathToFileURL(output).href, seconds: src.seconds, bytes, width: size.width, height: size.height };
    } catch (err) {
        fs.rmSync(runDir, { recursive: true, force: true });
        if (run.cancelled) throw new Error('Upscale cancelled');
        debug.error('movie', 'upscale FAILED', { error: err.message });
        throw err;
    } finally {
        if (upscaling === run) upscaling = null;
    }
}

function cancelUpscale() {
    if (upscaling) {
        upscaling.cancelled = true;
        upscaling.interrupt.current?.();
        try {
            if (upscaling.child) {
                if (process.platform === 'win32') spawn('taskkill', ['/pid', String(upscaling.child.pid), '/T', '/F'], { stdio: 'ignore' });
                else upscaling.child.kill('SIGTERM');
            }
        } catch { /* already gone */ }
    }
    return { ok: true };
}

function register() {
    ipcMain.handle('movie:export-title', (_, params) => exportTitle(params || {}));
    ipcMain.handle('movie:last-frame', (_, file) => lastFrame(file));
    ipcMain.handle('movie:upscale', (_, params) => upscale(params || {}));
    ipcMain.handle('movie:upscale-cancel', () => cancelUpscale());
    ipcMain.handle('movie:upscale-models', async () => {
        try { return { models: require('./comfyH3').bridge.upscaleModelFiles() }; } catch (err) { return { models: [], error: err.message }; }
    });
    const win = () => BrowserWindow.getAllWindows()[0] || null;
    ipcMain.handle('movie:status', () => {
        const f = findFfmpeg(true);
        return { ok: f.ok, ffmpeg: f.bin, version: f.version, error: f.ok ? '' : (f.bin ? 'ffmpeg is older than 4.3' : 'ffmpeg not found') };
    });
    ipcMain.handle('movie:options', () => ({
        transitions: TRANSITION_LIST,
        titleStyles: Object.entries(TITLE_STYLES).map(([id, s]) => [id, s.label]),
        captionStyles: Object.entries(CAPTION_STYLES).map(([id, s]) => [id, s.label]),
    }));
    ipcMain.handle('movie:probe', (_, files) => (files || []).map((f) => { try { return probeFile(checkMediaPath(f)); } catch (err) { return { path: f, error: err.message }; } }));
    ipcMain.handle('movie:render', (_, project) => render(project));
    ipcMain.handle('movie:cancel', () => cancel());
    ipcMain.handle('movie:library', () => library());
    ipcMain.handle('movie:import-bytes', (_, payload) => importBytes(payload));
    ipcMain.handle('movie:url', (_, file) => readableUrl(file));
    ipcMain.handle('movie:pick', async (_, kind) => {
        const res = await dialog.showOpenDialog(win(), { title: `Choose ${kind === 'audio' ? 'a music file' : kind === 'image' ? 'pictures' : 'videos'}`, properties: kind === 'audio' ? ['openFile'] : ['openFile', 'multiSelections'], filters: MEDIA_FILTERS[kind] || [] });
        return res.canceled ? [] : res.filePaths;
    });
    ipcMain.handle('movie:save-as', async (_, file) => {
        const full = checkMediaPath(file);
        const res = await dialog.showSaveDialog(win(), { title: 'Save the movie', defaultPath: path.join(app.getPath('videos'), `movie-${new Date().toISOString().slice(0, 10)}.mp4`), filters: MEDIA_FILTERS.video });
        if (res.canceled || !res.filePath) return null;
        fs.copyFileSync(full, res.filePath);
        return res.filePath;
    });
    ipcMain.handle('movie:reveal', (_, file) => { shell.showItemInFolder(checkMediaPath(file)); return { ok: true }; });
    app.on('before-quit', () => { cancel(); cancelUpscale(); });
}

module.exports = { register, findFfmpeg };
