// Movie maker: joins the clips and pictures made by the local studios into one finished movie
// (transitions, music, captions) with ffmpeg — everything stays on this machine.

const { ipcMain, app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { resolveLocalAiPaths } = require('./localInferencePaths');
const outputStore = require('./outputStore');
const { runFolder } = outputStore;
const { styledText, groupOf } = require('./movieText');
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
    // Cinzel Decorative (SIL Open Font License, see electron/assets/fonts) ships with the app for the artistic text styles.
    display: [path.join(__dirname, '..', 'assets', 'fonts', 'CinzelDecorative-Bold.ttf')],
    corsiva: ['C:/Windows/Fonts/MTCORSVA.TTF'],
    brush: ['C:/Windows/Fonts/BRUSHSCI.TTF'],
    hand: ['C:/Windows/Fonts/Inkfree.ttf'],
    blackletter: ['C:/Windows/Fonts/OLDENGL.TTF'],
    stencil: ['C:/Windows/Fonts/STENCIL.TTF'],
    copper: ['C:/Windows/Fonts/COPRGTB.TTF'],
    light: ['C:/Windows/Fonts/segoeuil.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf'],
    italic: ['C:/Windows/Fonts/georgiai.ttf', '/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf'],
    papyrus: ['C:/Windows/Fonts/PAPYRUS.TTF', '/System/Library/Fonts/Papyrus.ttc'],
    chiller: ['C:/Windows/Fonts/CHILLER.TTF'],
    showcard: ['C:/Windows/Fonts/SHOWG.TTF'],
    bauhaus: ['C:/Windows/Fonts/BAUHS93.TTF'],
    condensed: ['C:/Windows/Fonts/bahnschrift.ttf'],
    mono: ['C:/Windows/Fonts/consola.ttf', '/System/Library/Fonts/Menlo.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'],
};
// ffmpeg is a separate program and cannot read inside app.asar: files that it needs are unpacked next to it (package.json → asarUnpack).
const outsideAsar = (file) => file.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function findFonts() {
    const fonts = {};
    for (const [role, list] of Object.entries(FONT_CANDIDATES)) {
        const found = list.map(outsideAsar).find((f) => fs.existsSync(f));
        if (found) fonts[role] = found;
    }
    return fonts;
}

fs.mkdirSync(IMPORTS_DIR, { recursive: true });

// ─── ffmpeg lookup ─────────────────────────────────────────────────────────────
// Wan2GP ships a recent ffmpeg (the transitions need 4.3+; older system builds lack xfade).
let ffmpegCache;
function ffmpegVersion(bin) {
    const res = spawnSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 }); // a new 100 MB exe can take a while to start the first time (antivirus scan)
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
    if (!found.bin) throw new Error('ffmpeg was not found. Press "Install ffmpeg" in the Movie tab, install Wan2GP (it brings ffmpeg) or put ffmpeg.exe in local-ai/tools/ffmpeg.');
    if (!found.ok) throw new Error(`The ffmpeg found (${found.bin}) is too old for transitions (need 4.3+).`);
    return found.bin;
}


// ─── One-click ffmpeg (Windows) ────────────────────────────────────────────────
// The movie maker needs ffmpeg 4.3+. Wan2GP brings one; without it the official "essentials" build is downloaded next to the app's tools.
const FFMPEG_ZIP_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
let installingFfmpeg = false;

async function installFfmpeg() {
    if (process.platform !== 'win32') throw new Error('The one-click install is for Windows. On macOS use "brew install ffmpeg", on Linux your package manager (apt, dnf, pacman).');
    if (installingFfmpeg) throw new Error('ffmpeg is already being installed.');
    installingFfmpeg = true;
    const send = (data) => { for (const win of BrowserWindow.getAllWindows()) win.webContents.send('movie:ffmpeg-progress', data); };
    const dir = path.join(DATA_DIR, 'tools', 'ffmpeg');
    const work = path.join(dir, '_download');
    try {
        fs.rmSync(work, { recursive: true, force: true });
        fs.mkdirSync(work, { recursive: true });
        send({ phase: 'downloading', percent: 0 });
        const res = await fetch(FFMPEG_ZIP_URL, { redirect: 'follow' });
        if (!res.ok || !res.body) throw new Error(`Could not download ffmpeg (${res.status}). You can put ffmpeg.exe in ${dir} yourself.`);
        const total = Number(res.headers.get('content-length')) || 0;
        const zip = path.join(work, 'ffmpeg.zip');
        const out = fs.createWriteStream(zip);
        let received = 0;
        let last = 0;
        for await (const chunk of res.body) {
            out.write(chunk);
            received += chunk.length;
            const percent = total ? Math.round((received / total) * 100) : 0;
            if (percent !== last) { last = percent; send({ phase: 'downloading', percent }); }
        }
        await new Promise((resolve, reject) => { out.end((err) => (err ? reject(err) : resolve())); });
        send({ phase: 'unpacking', percent: 100 });
        const unpacked = path.join(work, 'unpacked');
        await new Promise((resolve, reject) => {
            const child = spawn('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${unpacked}' -Force`], { windowsHide: true });
            child.on('error', reject);
            child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Could not unpack the ffmpeg download.'))));
        });
        const found = [];
        const walk = (folder, depth) => {
            if (depth > 3) return;
            for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
                const full = path.join(folder, entry.name);
                if (entry.isDirectory()) walk(full, depth + 1);
                else if (/^ff(mpeg|probe)\.exe$/i.test(entry.name)) found.push(full);
            }
        };
        walk(unpacked, 0);
        const ffmpegExe = found.find((f) => /ffmpeg\.exe$/i.test(f));
        if (!ffmpegExe) throw new Error('The ffmpeg download did not contain ffmpeg.exe.');
        for (const file of found) fs.copyFileSync(file, path.join(dir, path.basename(file)));
        let check = findFfmpeg(true);
        for (let attempt = 0; attempt < 3 && !check.ok; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            check = findFfmpeg(true);
        }
        if (!check.ok) throw new Error('ffmpeg was installed but could not be started. Close and reopen the app, and try again.');
        debug.info('movie', 'ffmpeg installed', { dir, version: check.version });
        send({ phase: 'done', percent: 100 });
        return { ok: true, version: check.version };
    } catch (err) {
        send({ phase: 'error', message: err.message });
        throw err;
    } finally {
        installingFfmpeg = false;
        fs.rmSync(work, { recursive: true, force: true });
    }
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

/** What a movie is about, for its folder name: its name, else the first title or caption, else the first file. */
function movieLabel(project) {
    const clips = project.clips || [];
    const first = (key) => clips.map((c) => String(c[key] || '').trim()).find(Boolean);
    const file = clips.find((c) => c.path)?.path;
    return String(project.name || '').trim() || first('title') || first('caption') || (file ? path.parse(file).name : '');
}

async function render(project) {
    if (active) throw new Error('A movie is already being rendered.');
    const bin = requireFfmpeg();
    const run = { cancelled: false, child: null };
    active = run;
    const isPreview = project.quality === 'preview';
    // "2026-10-27 10-49-34 - reel discovery - Viking axe", "… - preview - vertical - Sunset" (a reel is vertical already)
    const label = movieLabel(project);
    const shape = /^reel\b/i.test(label) ? '' : project.height > project.width ? 'vertical' : project.height === project.width ? 'square' : '';
    const runDir = runFolder(MOVIES_DIR, [isPreview ? 'preview' : '', shape, label || 'movie']);
    fs.mkdirSync(runDir, { recursive: true });
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
            if (String(clip.caption || '').trim()) clip.captionFile = textFile('caption', styledText(clip.captionStyle, 'caption', clip.caption));
            if (String(clip.title || '').trim()) clip.titleFile = textFile('title', styledText(clip.titleStyle, 'title', clip.title));
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

// The bytes of a picture, so the image editor can draw it on a canvas without the browser treating it as another origin.
function readImage(file) {
    const full = path.resolve(String(file || ''));
    if (!/\.(png|jpe?g|webp|bmp)$/i.test(full) || !fs.existsSync(full)) throw new Error('That picture could not be opened.');
    return { bytes: fs.readFileSync(full), type: /\.png$/i.test(full) ? 'image/png' : /\.webp$/i.test(full) ? 'image/webp' : 'image/jpeg' };
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
    const dir = runFolder(MOVIES_DIR, ['title', params.title]);
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
        if (params.savePath) { // driven by MCP: no dialog, the caller names the file
            const target = path.resolve(String(params.savePath));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(out, target);
            debug.info('movie', 'transparent title saved', { path: target, format });
            return target;
        }
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
    // "… - upscale 4k - <the folder of the movie it comes from, without its date>"
    const source = path.basename(path.dirname(file)).replace(/^\d{4}-\d\d-\d\d \d\d-\d\d-\d\d - /, '');
    const runDir = runFolder(MOVIES_DIR, [`upscale ${target}`, /^\d+$/.test(source) ? path.parse(file).name : source]);
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


// Crop, rotate, flip and colour of a picture, saved as a new PNG (the original is never touched). Same options as the picture editor.
// crop: { x, y, width, height } as fractions of the picture (0..1), after the rotation and flip.
function editPicture(params = {}) {
    const bin = requireFfmpeg();
    const file = checkMediaPath(params.input);
    if (!/\.(png|jpe?g|webp|bmp)$/i.test(file)) throw new Error('input must be a png, jpg or webp picture.');
    const turns = (((Math.round((Number(params.rotate) || 0) / 90) % 4) + 4) % 4);
    const filters = [];
    if (turns === 1) filters.push('transpose=1');
    else if (turns === 2) filters.push('hflip,vflip');
    else if (turns === 3) filters.push('transpose=2');
    if (params.flip) filters.push('hflip');
    const c = params.crop;
    if (c) {
        const clamp = (v) => Math.min(1, Math.max(0, Number(v)));
        const x = clamp(c.x ?? 0);
        const y = clamp(c.y ?? 0);
        const w = Math.min(1 - x, Math.max(0.02, clamp(c.width ?? 1)));
        const h = Math.min(1 - y, Math.max(0.02, clamp(c.height ?? 1)));
        filters.push(`crop=trunc(iw*${w.toFixed(5)}/2)*2:trunc(ih*${h.toFixed(5)}/2)*2:trunc(iw*${x.toFixed(5)}/2)*2:trunc(ih*${y.toFixed(5)}/2)*2`);
    }
    const pct = (v) => Math.min(180, Math.max(40, Number(v) || 100)) / 100;
    const brightness = pct(params.brightness);
    const contrast = pct(params.contrast);
    const saturation = pct(params.saturation);
    if (brightness !== 1) filters.push(`lutrgb=r='clip(val*${brightness},0,255)':g='clip(val*${brightness},0,255)':b='clip(val*${brightness},0,255)'`);
    if (contrast !== 1 || saturation !== 1) filters.push(`eq=contrast=${contrast}:saturation=${saturation}`);
    if (!filters.length) filters.push('null');
    fs.mkdirSync(IMPORTS_DIR, { recursive: true });
    const out = path.join(IMPORTS_DIR, `edit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`);
    const res = spawnSync(bin, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-vf', filters.join(','), '-frames:v', '1', '-update', '1', out], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (res.status !== 0 || !fs.existsSync(out)) throw new Error(`Could not edit the picture: ${(res.stderr || '').trim().slice(-200)}`);
    debug.info('movie', 'picture edited', { input: file, output: out, turns, flip: !!params.flip, crop: c || null });
    return { path: out, url: pathToFileURL(out).href };
}

/** The choices of the movie maker as plain data (the interface and MCP both use them). */
function movieOptions() {
    const fonts = findFonts();
    return {
        transitions: TRANSITION_LIST,
        titleStyles: availableStyles('title', TITLE_STYLES, fonts),
        captionStyles: availableStyles('caption', CAPTION_STYLES, fonts),
    };
}

// ─── Text style menu ────────────────────────────────────────────────
/** Styles whose font exists on this computer (a style needs its own font; the plain ones always work), with the look the menu draws them in. */
function availableStyles(kind, table, fonts) {
    return Object.entries(table).filter(([, style]) => !!fonts[style.font]).map(([id, style]) => [id, style.label, groupOf(kind, id), {
        font: style.font, color: style.color, caps: !!style.caps, border: style.border || 0, borderColor: style.borderColor || '',
        box: style.box || '', shadow: style.shadow || null, size: style.sizeMul || (kind === 'title' ? Math.min(1.5, Math.max(1, style.scale || 1)) : 1),
    }]);
}

/** The font files of the styles, as bytes: the menu draws every entry in its own typeface. */
function fontBytes() {
    const fonts = findFonts();
    const out = {};
    for (const [role, file] of Object.entries(fonts)) { try { out[role] = fs.readFileSync(file); } catch { /* unreadable font: its styles fall back */ } }
    return out;
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
    ipcMain.handle('movie:install-ffmpeg', () => installFfmpeg());
    ipcMain.handle('movie:status', () => {
        const f = findFfmpeg(true);
        return { ok: f.ok, ffmpeg: f.bin, version: f.version, error: f.ok ? '' : (f.bin ? 'ffmpeg is older than 4.3' : 'ffmpeg not found') };
    });
    ipcMain.handle('movie:options', () => movieOptions());
    ipcMain.handle('movie:edit-picture', (_, params) => editPicture(params || {}));
    ipcMain.handle('movie:font-bytes', () => fontBytes());
    ipcMain.handle('movie:probe', (_, files) => (files || []).map((f) => { try { return probeFile(checkMediaPath(f)); } catch (err) { return { path: f, error: err.message }; } }));
    ipcMain.handle('movie:render', (_, project) => render(project));
    ipcMain.handle('movie:cancel', () => cancel());
    ipcMain.handle('movie:library', () => library());
    ipcMain.handle('movie:import-bytes', (_, payload) => importBytes(payload));
    ipcMain.handle('movie:url', (_, file) => readableUrl(file));
    ipcMain.handle('movie:read-image', (_, file) => readImage(file));
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

// `engine` is what the MCP server uses to run the movie maker without the interface.
module.exports = {
    register, findFfmpeg,
    engine: { render, cancel, upscale, cancelUpscale, exportTitle, library, lastFrame, probeFile, checkMediaPath, importBytes, editPicture, movieOptions, findFfmpeg },
};
