const { ipcMain, app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn, execFile } = require('child_process');
const { getHardwareProfile } = require('./hardwareProfile');
const { createPromptTranslator } = require('./promptTranslator');
const {
    getBundledBinaryResourceDir,
    pickBinaryAssetForPlatform,
} = require('./localInferenceAssets');
const {
    formatStartupProgressMessage,
    parseGenerationProgressChunk,
    resolveGenerationSteps,
    resolveGuidanceScale,
} = require('./localInferenceRuntime');
const {
    LOCAL_AI_DIR_ENV,
    resolveLocalAiPaths,
    writeStoredLocalAiDir,
} = require('./localInferencePaths');

// ─── Paths ────────────────────────────────────────────────────────────────────
// Resolved lazily (from register(), after app.whenReady()) so a failure here
// never crashes the process before a window exists — see #232.
let DATA_DIR, BIN_DIR, MODELS_DIR, TMP_DIR;

function ensureLocalAiPaths({ force = false } = {}) {
    if (BIN_DIR && !force) return;
    const resolved = resolveLocalAiPaths({ userDataPath: app.getPath('userData') });
    DATA_DIR = resolved.dataDir;
    BIN_DIR = resolved.binDir;
    MODELS_DIR = resolved.modelsDir;
    TMP_DIR = resolved.tmpDir;
    BINARY_PATH = path.join(BIN_DIR, BINARY_NAME);

    for (const dir of [BIN_DIR, MODELS_DIR, TMP_DIR]) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

const BINARY_NAME = process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli';
let BINARY_PATH;

// ─── State ────────────────────────────────────────────────────────────────────
let activeProcess = null;
let cancelRequested = false;

// ─── GitHub release asset matcher per platform ───────────────────────────────
// Asset names look like: sd-master-44cca3d-bin-Darwin-macOS-15.7.4-arm64.zip
// We pick the best match in priority order so a single release that only
// ships e.g. avx512 still resolves cleanly.
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'open-generative-ai' } }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode} from ${url}`));
                return;
            }
            let body = '';
            res.on('data', (d) => { body += d; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
            res.on('error', reject);
        }).on('error', reject);
    });
}

// ─── Robust HTTPS download with redirect-following, range-resume, and retry ───
// Two concurrent downloads of the same file would both append to the same .part
// and silently corrupt it, so callers share one in-flight download per destination.
const inflightDownloads = new Map();
function downloadFile(url, destPath, onProgress) {
    const existing = inflightDownloads.get(destPath);
    if (existing) return existing;
    const promise = downloadFileUnguarded(url, destPath, onProgress)
        .finally(() => inflightDownloads.delete(destPath));
    inflightDownloads.set(destPath, promise);
    return promise;
}

function downloadFileUnguarded(url, destPath, onProgress) {
    const tmp = destPath + '.part';

    // Outer total so progress never goes backwards across retries/redirects
    let knownTotal = 0;

    const attempt = (requestUrl, redirectsLeft, retriesLeft) => new Promise((resolve, reject) => {
        // Resume from however many bytes are already on disk
        const alreadyDownloaded = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;

        const parsed = new URL(requestUrl);
        const mod = parsed.protocol === 'https:' ? https : http;

        const reqHeaders = {
            'User-Agent': 'Mozilla/5.0 (compatible; open-generative-ai/1.0)',
            'Accept': '*/*',
            'Connection': 'keep-alive',
        };
        if (alreadyDownloaded > 0) reqHeaders['Range'] = `bytes=${alreadyDownloaded}-`;

        const req = mod.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: reqHeaders }, (res) => {
            const { statusCode, headers } = res;

            // Follow redirects
            if ([301, 302, 303, 307, 308].includes(statusCode)) {
                res.resume();
                if (redirectsLeft <= 0) { reject(new Error('Too many redirects')); return; }
                resolve(attempt(new URL(headers.location, requestUrl).href, redirectsLeft - 1, retriesLeft));
                return;
            }

            // 206 Partial Content (range accepted) or 200 OK (server ignored Range)
            if (statusCode !== 200 && statusCode !== 206) {
                res.resume();
                reject(new Error(`HTTP ${statusCode} from ${parsed.hostname}${parsed.pathname}`));
                return;
            }

            // content-length on a 206 is the remaining bytes; on 200 it's the full file
            const chunkSize = parseInt(headers['content-length'] || '0', 10);
            if (statusCode === 200) {
                // Server ignored our Range header — restart the file
                if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
                knownTotal = chunkSize;
            } else {
                // 206: total = already downloaded + remaining
                knownTotal = alreadyDownloaded + chunkSize;
            }

            let received = alreadyDownloaded;
            const out = fs.createWriteStream(tmp, { flags: statusCode === 206 ? 'a' : 'w' });

            res.on('data', (chunk) => {
                received += chunk.length;
                if (knownTotal && onProgress) onProgress(received / knownTotal);
            });
            res.pipe(out);
            out.on('finish', () => {
                // A truncated or doubled file would load fine and then produce garbage images
                if (knownTotal && fs.statSync(tmp).size !== knownTotal) {
                    fs.unlinkSync(tmp);
                    reject(new Error('Downloaded file size does not match the server — please retry'));
                    return;
                }
                fs.renameSync(tmp, destPath);
                resolve();
            });
            out.on('error', reject);
            res.on('error', reject);
        });

        req.on('error', (err) => {
            if (retriesLeft > 0) {
                console.warn(`[download] ${err.message} — retrying in 3s (${retriesLeft} left)`);
                setTimeout(() => resolve(attempt(requestUrl, redirectsLeft, retriesLeft - 1)), 3000);
            } else {
                reject(err);
            }
        });

        req.setTimeout(60000, () => req.destroy(new Error('Request timed out')));
    });

    return attempt(url, 10, 5);
}

// ─── Extract zip on each platform ────────────────────────────────────────────
function extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        let cmd, args;
        if (process.platform === 'win32') {
            cmd = 'powershell';
            args = ['-NoProfile', '-Command', `Expand-Archive -Force -Path "${zipPath}" -DestinationPath "${destDir}"`];
        } else {
            cmd = 'unzip';
            args = ['-o', zipPath, '-d', destDir];
        }
        execFile(cmd, args, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// ─── Binary management ────────────────────────────────────────────────────────
// Recursively find a file by name under dir; returns full path or null.
function findFile(dir, name) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findFile(full, name);
            if (found) return found;
        } else if (entry.name === name) {
            return full;
        }
    }
    return null;
}

function ensureBinaryPermissions() {
    if (process.platform === 'win32') return;

    for (const fileName of [
        BINARY_NAME,
        'sd-server',
        'libstable-diffusion.dylib',
        'libstable-diffusion.so',
    ]) {
        const fullPath = findFile(BIN_DIR, fileName);
        if (fullPath) fs.chmodSync(fullPath, 0o755);
    }
}

function ensureBundledBinaryInstalled() {
    if (fs.existsSync(BINARY_PATH)) {
        ensureBinaryPermissions();
        return true;
    }

    if (!app.isPackaged) return false;

    const bundledDir = getBundledBinaryResourceDir({
        resourcesPath: process.resourcesPath,
        platform: process.platform,
        arch: process.arch,
    });
    const bundledBinaryPath = path.join(bundledDir, BINARY_NAME);
    if (!fs.existsSync(bundledBinaryPath)) return false;

    fs.cpSync(bundledDir, BIN_DIR, { recursive: true, force: true });
    ensureBinaryPermissions();
    return fs.existsSync(BINARY_PATH);
}

async function getBinaryStatus() {
    const exists = ensureBundledBinaryInstalled() || fs.existsSync(BINARY_PATH);
    return {
        exists,
        path: BINARY_PATH,
        dataDir: DATA_DIR,
        modelsDir: MODELS_DIR,
        envVar: LOCAL_AI_DIR_ENV,
        envOverride: !!(process.env[LOCAL_AI_DIR_ENV] || '').trim(),
    };
}

// ─── Storage location (chosen from the UI) ───────────────────────────────────
async function pickStorageFolder(mainWindow) {
    if ((process.env[LOCAL_AI_DIR_ENV] || '').trim()) {
        throw new Error(`The location is fixed by the ${LOCAL_AI_DIR_ENV} environment variable — remove it to change the folder from here.`);
    }
    if (activeProcess || inflightDownloads.size) {
        throw new Error('Wait for the running generation or download to finish before changing the folder.');
    }

    const res = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose where to store engine and models',
        defaultPath: DATA_DIR,
        properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;

    const target = path.resolve(res.filePaths[0]);
    if (target === path.resolve(DATA_DIR)) return getBinaryStatus();
    // Never nest the store inside the old one: the move would copy a folder into itself.
    if (target.toLowerCase().startsWith(path.resolve(DATA_DIR).toLowerCase() + path.sep)) {
        throw new Error('Choose a folder outside the current storage folder.');
    }

    const oldDir = DATA_DIR;
    const hasFiles = fs.existsSync(MODELS_DIR) && fs.readdirSync(MODELS_DIR).length > 0;
    let move = false;
    if (hasFiles) {
        const { response } = await dialog.showMessageBox(mainWindow, {
            type: 'question',
            title: 'Existing models',
            message: 'Move the existing engine and models to the new folder?',
            detail: `From: ${oldDir}
To: ${target}

Moving large models can take a few minutes.`,
            buttons: ['Move files', 'Use new folder (leave files)', 'Cancel'],
            defaultId: 0,
            cancelId: 2,
        });
        if (response === 2) return null;
        move = response === 0;
    }

    if (move) {
        for (const sub of ['bin', 'models']) {
            const from = path.join(oldDir, sub);
            if (!fs.existsSync(from)) continue;
            const to = path.join(target, sub);
            fs.mkdirSync(to, { recursive: true });
            fs.cpSync(from, to, { recursive: true, force: true });
        }
    }

    writeStoredLocalAiDir(app.getPath('userData'), target);
    ensureLocalAiPaths({ force: true });

    if (move) {
        // Remove the old copy only after the new one is in place and the config is saved.
        for (const sub of ['bin', 'models']) {
            fs.rmSync(path.join(oldDir, sub), { recursive: true, force: true });
        }
    }
    return getBinaryStatus();
}

// Metal-enabled binaries hosted on our own release (macOS arm64 only).
// Other platforms fall back to the stock leejet release.
const CUSTOM_BINARIES = {
    'darwin-arm64': 'https://github.com/Anil-matcha/Open-Generative-AI/releases/download/v1.0.3-binaries/sd-cli-metal-macos-arm64.zip',
};

async function downloadBinary(mainWindow) {
    const send = (data) => mainWindow?.webContents.send('local-ai:download-progress', { id: '__binary__', ...data });

    try {
        send({ phase: 'fetching-release', progress: 0 });

        if (ensureBundledBinaryInstalled()) {
            send({ phase: 'done', progress: 1 });
            return { ok: true, source: 'bundled' };
        }

        const platformKey = `${process.platform}-${process.arch}`;
        const customUrl = CUSTOM_BINARIES[platformKey];

        let downloadUrl, zipName;

        if (customUrl) {
            downloadUrl = customUrl;
            zipName = path.basename(customUrl);
        } else {
            // Walk recent releases until we find one that actually ships a
            // build for this platform. leejet sometimes publishes a partial
            // release (e.g. master-587 ships only Mac arm64 + Linux ROCm),
            // so the very latest tag isn't always usable.
            const releases = await fetchJson(
                'https://api.github.com/repos/leejet/stable-diffusion.cpp/releases?per_page=15'
            );

            let chosen = null;
            let lastSeen = [];
            for (const release of releases) {
                const zips = (release.assets || [])
                    .filter(a => a.name.endsWith('.zip'));
                lastSeen = zips.map(a => a.name);
                const pickedName = pickBinaryAssetForPlatform({
                    platform: process.platform,
                    arch: process.arch,
                    zipNames: lastSeen,
                });
                if (pickedName) {
                    chosen = zips.find(a => a.name === pickedName);
                    break;
                }
            }

            if (!chosen) {
                if (process.platform === 'darwin' && process.arch !== 'arm64') {
                    throw new Error('Local inference on macOS only supports Apple Silicon (M1/M2/M3/M4). Mac Intel is not supported by stable-diffusion.cpp upstream.');
                }
                if (process.platform === 'linux' && process.arch === 'arm64') {
                    throw new Error('No upstream stable-diffusion.cpp binary found for linux-arm64. Install a build that bundles local-ai/linux-arm64/bin or provide the binary manually.');
                }
                const available = lastSeen.join(', ') || '(none)';
                throw new Error(`No binary found for ${process.platform}-${process.arch} in the last 15 releases. Latest release assets: ${available}`);
            }
            downloadUrl = chosen.browser_download_url;
            zipName = chosen.name;
        }

        send({ phase: 'downloading', progress: 0 });
        const zipPath = path.join(BIN_DIR, zipName);
        await downloadFile(downloadUrl, zipPath, (p) => {
            send({ phase: 'downloading', progress: p });
        });

        send({ phase: 'extracting', progress: 0.95 });
        await extractZip(zipPath, BIN_DIR);
        fs.unlinkSync(zipPath);

        // The zip may extract into a subdirectory — find the binary wherever it landed
        const foundBinary = findFile(BIN_DIR, BINARY_NAME);
        if (!foundBinary) throw new Error(`Extracted archive but could not find "${BINARY_NAME}" inside ${BIN_DIR}`);

        // Move it to the expected root location if it's nested
        if (foundBinary !== BINARY_PATH) {
            fs.renameSync(foundBinary, BINARY_PATH);
        }

        ensureBinaryPermissions();

        // macOS: strip Gatekeeper quarantine so the downloaded binary can run
        if (process.platform === 'darwin') {
            await new Promise((res) => execFile('xattr', ['-cr', BIN_DIR], () => res()));
        }

        send({ phase: 'done', progress: 1 });
        return { ok: true };
    } catch (err) {
        send({ phase: 'error', error: err.message });
        throw err;
    }
}

// ─── Model management ─────────────────────────────────────────────────────────
function getModelState(model) {
    const filePath = path.join(MODELS_DIR, model.filename);
    const partPath = filePath + '.part';
    if (fs.existsSync(filePath)) return 'downloaded';
    if (fs.existsSync(partPath)) return 'partial';
    return 'not-downloaded';
}

function getAuxState(aux) {
    const filePath = path.join(MODELS_DIR, aux.filename);
    return fs.existsSync(filePath) ? 'downloaded' : 'not-downloaded';
}

async function listModels() {
    const { LOCAL_MODEL_CATALOG, ZIMAGE_AUXILIARY } = require('./modelCatalog');
    const { rateAgainst, sdRequirements, shouldDemoteLegacy } = require('./wan2gpFit');
    const hardware = await getHardwareProfile(MODELS_DIR);
    const auxStatus = {
        llm: getAuxState(ZIMAGE_AUXILIARY.llm),
        vae: getAuxState(ZIMAGE_AUXILIARY.vae),
    };
    return LOCAL_MODEL_CATALOG.map(m => {
        const state = getModelState(m);
        // Size of everything this model still has to download (main file + missing components).
        const auxList = m.requiresAuxiliary ? [ZIMAGE_AUXILIARY.llm, ZIMAGE_AUXILIARY.vae] : [];
        const auxGB = auxList.reduce((sum, a) => sum + (a.sizeGB || 0), 0);
        const missingGB = (state === 'downloaded' ? 0 : (m.sizeGB || 0))
            + auxList.filter(a => getAuxState(a) !== 'downloaded').reduce((sum, a) => sum + (a.sizeGB || 0), 0);
        // Without an NVIDIA GPU (Apple Silicon, AMD, CPU-only) sd.cpp still runs, so do not judge.
        const rated = hardware.vramGB === null
            ? { fit: 'unknown', reason: '', downloadGB: null }
            : rateAgainst(sdRequirements(m, auxGB, missingGB), hardware, missingGB > 0);
        return {
            ...m,
            state,
            path: path.join(MODELS_DIR, m.filename),
            ...(m.requiresAuxiliary ? { auxiliaryStatus: auxStatus } : {}),
            fit: rated.fit,
            fitReason: rated.reason,
            downloadGB: rated.downloadGB,
            legacyDemoted: !!m.legacy && shouldDemoteLegacy(hardware),
        };
    });
}

async function downloadModel(modelId, mainWindow) {
    const { LOCAL_MODEL_CATALOG } = require('./modelCatalog');
    const model = LOCAL_MODEL_CATALOG.find(m => m.id === modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    const destPath = path.join(MODELS_DIR, model.filename);
    if (fs.existsSync(destPath)) return { ok: true, path: destPath };

    const send = (data) => mainWindow?.webContents.send('local-ai:download-progress', { id: modelId, ...data });
    send({ phase: 'downloading', progress: 0 });

    try {
        await downloadFile(model.downloadUrl, destPath, (p) => {
            send({ phase: 'downloading', progress: p });
        });
    } catch (err) {
        throw new Error(`Failed to download "${model.name}" (id: ${model.id}, url: ${model.downloadUrl}): ${err.message}`);
    }

    send({ phase: 'done', progress: 1 });
    return { ok: true, path: destPath };
}

async function downloadAuxiliary(auxKey, mainWindow) {
    const { ZIMAGE_AUXILIARY } = require('./modelCatalog');
    const aux = ZIMAGE_AUXILIARY[auxKey];
    if (!aux) throw new Error(`Unknown auxiliary file: ${auxKey}`);

    const destPath = path.join(MODELS_DIR, aux.filename);
    if (fs.existsSync(destPath)) return { ok: true, path: destPath };

    const id = aux.id;
    const send = (data) => mainWindow?.webContents.send('local-ai:download-progress', { id, ...data });
    send({ phase: 'downloading', progress: 0 });

    try {
        await downloadFile(aux.downloadUrl, destPath, (p) => {
            send({ phase: 'downloading', progress: p });
        });
    } catch (err) {
        throw new Error(`Failed to download "${aux.displayName}" (id: ${aux.id}, url: ${aux.downloadUrl}): ${err.message}`);
    }

    send({ phase: 'done', progress: 1 });
    return { ok: true, path: destPath };
}

async function deleteModel(modelId) {
    const { LOCAL_MODEL_CATALOG } = require('./modelCatalog');
    const model = LOCAL_MODEL_CATALOG.find(m => m.id === modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    const filePath = path.join(MODELS_DIR, model.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const partPath = filePath + '.part';
    if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
    return { ok: true };
}

// ─── Generation ───────────────────────────────────────────────────────────────
function arToDimensions(ar, modelType) {
    const base = (modelType === 'sdxl' || modelType === 'z-image') ? 1024 : 512;
    const map = {
        '1:1': [base, base],
        '16:9': [Math.round(base * 16 / 9 / 64) * 64, base],
        '9:16': [base, Math.round(base * 16 / 9 / 64) * 64],
        '4:3': [Math.round(base * 4 / 3 / 64) * 64, base],
        '3:4': [base, Math.round(base * 4 / 3 / 64) * 64],
    };
    if (map[ar]) return map[ar];

    // Any other "w:h" ratio (e.g. 3:2, 2:3, 21:9): keep the short side at `base`, cap the long side.
    const m = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(String(ar || '').trim());
    const rw = m ? Number(m[1]) : 0;
    const rh = m ? Number(m[2]) : 0;
    if (!(rw > 0 && rh > 0)) return [base, base];
    const maxSide = base * 1.75;
    const snap = (v) => Math.max(64, Math.round(v / 64) * 64);
    return rw >= rh
        ? [snap(Math.min(base * rw / rh, maxSide)), base]
        : [base, snap(Math.min(base * rh / rw, maxSide))];
}

// Non-English prompts are translated first (see promptTranslator.js). Shared with the Wan2GP provider.
let translator = null;
function getTranslator() {
    if (!translator) {
        const { ZIMAGE_AUXILIARY } = require('./modelCatalog');
        translator = createPromptTranslator({
            getPaths: () => ({ dataDir: DATA_DIR, modelsDir: MODELS_DIR }),
            downloadFile,
            llmFilename: ZIMAGE_AUXILIARY.llm.filename,
            settingsFile: path.join(app.getPath('userData'), 'local-ai-settings.json'),
        });
    }
    return translator;
}
function translatePrompts(params, send) {
    return getTranslator().translateParams(params, (message) => send({ status: 'starting', progress: 0, message }));
}

async function generate(params, mainWindow) {
    const { LOCAL_MODEL_CATALOG, ZIMAGE_AUXILIARY } = require('./modelCatalog');
    const send = (data) => mainWindow?.webContents.send('local-ai:progress', data);

    if (activeProcess) throw new Error('A generation is already running — wait for it to finish or cancel it.');
    ensureBundledBinaryInstalled();
    if (!fs.existsSync(BINARY_PATH)) throw new Error('sd.cpp binary not installed. Download it in Settings > Local Models.');

    const model = LOCAL_MODEL_CATALOG.find(m => m.id === params.model);
    if (!model) throw new Error(`Unknown local model: ${params.model}`);

    const modelPath = path.join(MODELS_DIR, model.filename);
    if (!fs.existsSync(modelPath)) throw new Error(`Model file not found. Download "${model.name}" in Settings > Local Models.`);

    if (model.requiresAuxiliary) {
        const llmPath = path.join(MODELS_DIR, ZIMAGE_AUXILIARY.llm.filename);
        const vaePath = path.join(MODELS_DIR, ZIMAGE_AUXILIARY.vae.filename);
        if (!fs.existsSync(llmPath)) throw new Error('Text encoder (Qwen3-4B) not downloaded. Go to Settings > Local Models and download all required files for Z-Image.');
        if (!fs.existsSync(vaePath)) throw new Error('VAE (ae.safetensors) not downloaded. Go to Settings > Local Models and download all required files for Z-Image.');
    }

    const translated = await translatePrompts(params, send);
    params = translated.params;

    const [width, height] = arToDimensions(params.aspect_ratio || '1:1', model.type);
    const seed = params.seed && params.seed !== -1 ? params.seed : Math.floor(Math.random() * 2147483647);
    const outPath = path.join(TMP_DIR, `gen-${Date.now()}.png`);

    const steps = resolveGenerationSteps(params, model);
    const cfgScale = resolveGuidanceScale(params, model);
    const sampler = model.sampler || 'euler_a';

    // z-image GGUFs are standalone diffusion transformers loaded via --diffusion-model.
    // -m triggers full-model SD version detection which fails for these files (0 KV metadata).
    const modelFlag = (model.type === 'z-image' || model.type === 'flux')
        ? '--diffusion-model'
        : '-m';

    const args = [
        modelFlag, modelPath,
        '-p', params.prompt || '',
        '-o', outPath,
        '--steps', String(steps),
        '-H', String(height),
        '-W', String(width),
        '--cfg-scale', String(cfgScale),
        '--seed', String(seed),
        '--sampling-method', sampler,
        '-v',
    ];

    if (params.negative_prompt) {
        args.push('-n', params.negative_prompt);
    }

    if (model.type === 'z-image') {
        const llmPath = path.join(MODELS_DIR, ZIMAGE_AUXILIARY.llm.filename);
        const vaePath = path.join(MODELS_DIR, ZIMAGE_AUXILIARY.vae.filename);
        args.push('--llm', llmPath);
        args.push('--vae', vaePath);
        if (model.scheduler) args.push('--scheduler', model.scheduler);
    } else if (model.type === 'sdxl') {
        args.push('--sd-version', 'sdxl');
    } else if (model.type === 'sd2') {
        args.push('--sd-version', 'sd2');
    } else if (model.type === 'flux') {
        args.push('--flux');
    }

    return new Promise((resolve, reject) => {
        const startupStartedAt = Date.now();
        let startupHeartbeat = null;
        let samplingStarted = false;

        const sendStartupProgress = () => {
            send({
                step: 0,
                totalSteps: steps,
                status: 'starting',
                progress: 0,
                message: formatStartupProgressMessage(Date.now() - startupStartedAt),
            });
        };
        const stopStartupHeartbeat = () => {
            if (startupHeartbeat) {
                clearInterval(startupHeartbeat);
                startupHeartbeat = null;
            }
        };

        sendStartupProgress();
        startupHeartbeat = setInterval(() => {
            if (!samplingStarted) sendStartupProgress();
        }, 5000);

        console.log('[sd-cli] command:', BINARY_PATH, args.join(' '));
        // DYLD_LIBRARY_PATH lets macOS find libstable-diffusion.dylib next to sd-cli
        const spawnEnv = { ...process.env, DYLD_LIBRARY_PATH: BIN_DIR, LD_LIBRARY_PATH: BIN_DIR };
        cancelRequested = false;
        activeProcess = spawn(BINARY_PATH, args, { env: spawnEnv });
        const progressState = { tail: '', lastStep: 0, lastTotalSteps: 0 };
        const outputLines = [];

        const handleOutput = (data) => {
            const line = data.toString();
            outputLines.push(line.trimEnd());
            const progressEvents = parseGenerationProgressChunk(line, progressState);
            for (const event of progressEvents) {
                samplingStarted = true;
                stopStartupHeartbeat();
                send({ ...event, status: 'generating' });
            }
        };

        activeProcess.stdout.on('data', handleOutput);
        activeProcess.stderr.on('data', handleOutput);

        activeProcess.on('close', (code) => {
            stopStartupHeartbeat();
            activeProcess = null;
            const allOutput = outputLines.filter(l => l.trim()).join('\n');
            console.error('[sd-cli] full output:\n' + allOutput);
            if (cancelRequested) {
                reject(new Error('Generation cancelled'));
                return;
            }
            if (code !== 0) {
                const tail = outputLines.filter(l => l.trim()).slice(-20).join('\n');
                const killed = code === null;
                const hint = killed
                    ? 'sd-cli was terminated before finishing (often OOM on Z-Image/SDXL — try a smaller SD 1.5 model or close other apps). '
                    : '';
                reject(new Error(`${hint}sd-cli exited (code ${code ?? 'signal'}):\n${tail}`));
                return;
            }
            if (!fs.existsSync(outPath)) {
                reject(new Error('sd.cpp finished but no output image found'));
                return;
            }
            try {
                const imgBuffer = fs.readFileSync(outPath);
                const dataUrl = `data:image/png;base64,${imgBuffer.toString('base64')}`;
                // Kept in the same folder as Wan2GP results: it makes the history survive a restart,
                // and "Delete" / "Delete all" / the usage figure already cover that folder.
                let savedPath;
                try {
                    const runDir = path.join(DATA_DIR, 'wan2gp', 'runs', `sd-${Date.now()}`);
                    fs.mkdirSync(runDir, { recursive: true });
                    savedPath = path.join(runDir, 'image.png');
                    fs.writeFileSync(savedPath, imgBuffer);
                } catch { savedPath = undefined; }
                fs.unlinkSync(outPath);
                send({ step: steps, totalSteps: steps, status: 'done', progress: 1 });
                resolve({ url: dataUrl, seed, translatedPrompt: translated.translatedPrompt, ...(savedPath ? { path: savedPath } : {}) });
            } catch (err) {
                reject(err);
            }
        });

        activeProcess.on('error', (err) => {
            stopStartupHeartbeat();
            activeProcess = null;
            reject(err);
        });
    });
}

function cancelGeneration() {
    if (activeProcess) {
        cancelRequested = true;
        activeProcess.kill('SIGTERM');
        activeProcess = null;
    }
    return { ok: true };
}

// ─── IPC Registration ─────────────────────────────────────────────────────────
function getMainWindow() {
    return BrowserWindow.getAllWindows()[0] || null;
}

function register() {
    ensureLocalAiPaths();
    ipcMain.handle('local-ai:binary-status', () => getBinaryStatus());
    ipcMain.handle('local-ai:translate', async (_, text) => {
        const { params, translatedPrompt } = await translatePrompts({ prompt: String(text || '') }, (d) => getMainWindow()?.webContents.send('local-ai:progress', d));
        return { text: params.prompt, translatedPrompt };
    });
    ipcMain.handle('local-ai:enhance-prompt', (_, text) => getTranslator().enhance(text, (message) => getMainWindow()?.webContents.send('local-ai:progress', { status: 'starting', progress: 0, message })));
    ipcMain.handle('local-ai:get-settings', () => getTranslator().getSettings());
    ipcMain.handle('local-ai:set-settings', (_, patch) => { getTranslator().setSettings(patch || {}); return getTranslator().getSettings(); });
    ipcMain.handle('local-ai:pick-storage', () => pickStorageFolder(getMainWindow()));
    ipcMain.handle('local-ai:download-binary', () => downloadBinary(getMainWindow()));
    ipcMain.handle('local-ai:list-models', () => listModels());
    ipcMain.handle('local-ai:download-model', (_, modelId) => downloadModel(modelId, getMainWindow()));
    ipcMain.handle('local-ai:download-auxiliary', (_, auxKey) => downloadAuxiliary(auxKey, getMainWindow()));
    ipcMain.handle('local-ai:delete-model', (_, modelId) => deleteModel(modelId));
    ipcMain.handle('local-ai:generate', (_, params) => generate(params, getMainWindow()));
    ipcMain.handle('local-ai:cancel-generation', () => cancelGeneration());
}

module.exports = {
    register,
    downloadFile,
    translatePrompts,
    getDataDir: () => DATA_DIR,
};
