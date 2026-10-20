// Local prompt translation. Most image/video models understand English far better than other
// languages (an Italian "staccionata" turns into a plant stem, not a fence), so prompts that are
// not English are translated first — on this PC, with the Qwen3-4B-Instruct model that Z-Image
// already uses as its text encoder, run by a small llama.cpp helper downloaded on first use.
// Nothing is sent to any online service. Only the pure helpers are meant to be unit-tested.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const SYSTEM_PROMPT = 'You translate image-generation prompts into English. Output only the English prompt, nothing else. '
    + 'If the prompt is already in English, repeat it unchanged. Keep every detail, name and the style.';

// Words that are strong signals of a language and (almost) never appear in English prompts.
const STOPWORDS = {
    it: ['una', 'uno', 'un', 'il', 'lo', 'la', 'gli', 'le', 'di', 'del', 'della', 'dei', 'delle', 'su', 'sul', 'sulla', 'con', 'per', 'che', 'nel', 'nella', 'sono', 'cosa', 'mattina', 'sera', 'notte', 'giorno', 'bella', 'bello', 'molto'],
    es: ['una', 'el', 'los', 'las', 'del', 'con', 'por', 'para', 'que', 'sobre', 'en', 'muy', 'noche', 'mañana', 'día'],
    fr: ['une', 'le', 'les', 'des', 'du', 'avec', 'pour', 'sur', 'dans', 'est', 'très', 'nuit', 'matin', 'jour'],
    de: ['ein', 'eine', 'der', 'die', 'das', 'und', 'mit', 'auf', 'ist', 'sehr', 'nacht', 'morgen', 'im'],
    pt: ['uma', 'um', 'os', 'as', 'do', 'da', 'com', 'para', 'sobre', 'muito', 'noite', 'manhã'],
};
const ENGLISH_STOPWORDS = new Set(['a', 'an', 'the', 'and', 'with', 'of', 'on', 'in', 'at', 'to', 'for', 'is', 'are', 'by', 'from', 'her', 'his', 'its', 'my', 'very', 'morning', 'night']);
const NON_LATIN = /[\u0370-\u03FF\u0400-\u04FF\u0590-\u06FF\u0900-\u0DFF\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/;

/** True when the text looks like it is not English (cheap heuristic, no model involved). */
function needsTranslation(text) {
    const value = String(text || '').trim();
    if (value.length < 3) return false;
    if (NON_LATIN.test(value)) return true;

    const words = value.toLowerCase().match(/[\p{L}']+/gu) || [];
    if (!words.length) return false;
    const foreign = new Set();
    for (const list of Object.values(STOPWORDS)) for (const w of list) foreign.add(w);
    // "a", "in", "on"... exist in English too; ambiguous words are not counted as foreign
    for (const w of ENGLISH_STOPWORDS) foreign.delete(w);

    let foreignHits = 0;
    let englishHits = 0;
    for (const w of words) {
        if (foreign.has(w)) foreignHits++;
        else if (ENGLISH_STOPWORDS.has(w)) englishHits++;
    }
    return foreignHits >= 2 && foreignHits > englishHits;
}

/** ChatML prompt understood by Qwen models. */
function buildChatPrompt(text) {
    return `<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>\n<|im_start|>user\n${text}<|im_end|>\n<|im_start|>assistant\n`;
}

/** Clean the raw model output; returns '' when it cannot be trusted (caller keeps the original). */
function parseTranslation(output, original) {
    let text = String(output || '')
        .replace(/\[end of text\]/gi, '')
        .replace(/<\|im_end\|>/g, '')
        .replace(/^\s*["'“”]+|["'“”]+\s*$/g, '')
        .trim();
    if (!text) return '';
    // A runaway answer (explanations, loops) is worse than the untranslated prompt.
    if (text.length > Math.max(200, original.length * 4)) return '';
    if (text.includes('\n\n')) text = text.split('\n\n')[0].trim();
    return text;
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'open-generative-ai', Accept: 'application/vnd.github+json' } }, (res) => {
            if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
            let body = '';
            res.on('data', (d) => { body += d; });
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

// Prefer the GPU (Vulkan / Metal) build — a 4B model on the CPU needs ~15 s, on the GPU ~4 s.
const ASSET_PATTERNS = {
    'win32-x64': [/bin-win-vulkan-x64\.zip$/, /bin-win-cpu-x64\.zip$/],
    'linux-x64': [/bin-ubuntu-vulkan-x64\.(zip|tar\.gz)$/, /bin-ubuntu-x64\.(zip|tar\.gz)$/],
    'darwin-arm64': [/bin-macos-arm64\.(zip|tar\.gz)$/],
    'darwin-x64': [/bin-macos-x64\.(zip|tar\.gz)$/],
};

function pickAsset(releases, platformKey) {
    const patterns = ASSET_PATTERNS[platformKey];
    if (!patterns) return null;
    for (const release of releases) {
        for (const pattern of patterns) {
            const asset = (release.assets || []).find(a => pattern.test(a.name));
            if (asset) return asset;
        }
    }
    return null;
}

function findFile(dir, name) {
    if (!fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === name) return full;
        if (entry.isDirectory()) {
            const found = findFile(full, name);
            if (found) return found;
        }
    }
    return null;
}

function run(cmd, args, { timeoutMs = 120000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('timed out')); }, timeoutMs);
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(out);
            else reject(new Error(`${path.basename(cmd)} exited with code ${code}: ${err.slice(-300)}`));
        });
    });
}

function extractArchive(archive, dest) {
    fs.mkdirSync(dest, { recursive: true });
    if (process.platform === 'win32') {
        // The system tar reads zip files; a GNU tar earlier on PATH would take "E:\..." for a remote host.
        return run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', dest]);
    }
    return archive.endsWith('.zip') ? run('unzip', ['-o', archive, '-d', dest]) : run('tar', ['-xzf', archive, '-C', dest]);
}

/**
 * @param {{
 *   getPaths: () => { dataDir: string, modelsDir: string },
 *   downloadFile: (url: string, dest: string) => Promise<void>,
 *   llmFilename: string,
 *   settingsFile: string,
 * }} options
 */
function createPromptTranslator({ getPaths, downloadFile, llmFilename, settingsFile }) {
    const cache = new Map();
    let enginePromise = null;

    const readSettings = () => {
        try { return { translatePrompts: true, ...JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) }; }
        catch { return { translatePrompts: true }; }
    };
    const writeSettings = (patch) => {
        const next = { ...readSettings(), ...patch };
        fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
        fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2));
        return next;
    };

    const binaryName = process.platform === 'win32' ? 'llama-completion.exe' : 'llama-completion';
    const engineDir = () => path.join(getPaths().dataDir, 'tools', 'llama');
    const findEngine = () => findFile(engineDir(), binaryName);
    const modelPath = () => path.join(getPaths().modelsDir, llmFilename);

    async function ensureEngine(onStatus) {
        const existing = findEngine();
        if (existing) return existing;
        const key = `${process.platform}-${process.arch}`;
        if (!ASSET_PATTERNS[key]) throw new Error(`Prompt translation is not available on ${key}.`);

        onStatus?.('Downloading the translation helper (one time, ~36 MB)…');
        const releases = await getJson('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=8');
        const asset = pickAsset(releases, key);
        if (!asset) throw new Error('No llama.cpp build found for this system.');

        const dir = engineDir();
        fs.mkdirSync(dir, { recursive: true });
        const archive = path.join(dir, asset.name);
        await downloadFile(asset.browser_download_url, archive);
        await extractArchive(archive, dir);
        fs.unlinkSync(archive);
        const binary = findEngine();
        if (!binary) throw new Error('The translation helper was downloaded but its program was not found.');
        if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
        return binary;
    }

    async function runModel(binary, text) {
        const args = ['-m', modelPath(), '--no-display-prompt', '--temp', '0', '-n', '120', '-ngl', '99', '-no-cnv', '-p', buildChatPrompt(text)];
        const out = await run(binary, args, { timeoutMs: 180000 });
        return parseTranslation(out, text);
    }

    /** Translate one text; resolves to the original on any problem. */
    async function translate(text, onStatus) {
        if (cache.has(text)) return cache.get(text);
        if (!fs.existsSync(modelPath())) return text;   // the Qwen3 model is not on disk (no Z-Image download yet)
        try {
            enginePromise = enginePromise || ensureEngine(onStatus).finally(() => { enginePromise = null; });
            const binary = await enginePromise;
            onStatus?.('Translating the prompt…');
            const result = (await runModel(binary, text)) || text;
            cache.set(text, result);
            return result;
        } catch (err) {
            console.warn('[translate] skipped:', err.message);
            return text;
        }
    }

    /**
     * Returns params with prompt (and negative prompt) in English when they were not.
     * `translatedPrompt` is set only when something changed.
     */
    async function translateParams(params, onStatus) {
        if (!readSettings().translatePrompts) return { params, translatedPrompt: null };
        const next = { ...params };
        let translatedPrompt = null;
        if (needsTranslation(params.prompt)) {
            const result = await translate(String(params.prompt).trim(), onStatus);
            if (result !== params.prompt) { next.prompt = result; translatedPrompt = result; }
        }
        if (needsTranslation(params.negative_prompt)) {
            next.negative_prompt = await translate(String(params.negative_prompt).trim(), onStatus);
        }
        return { params: next, translatedPrompt };
    }

    return {
        translateParams,
        getSettings: () => ({ ...readSettings(), engineInstalled: !!findEngine(), modelAvailable: fs.existsSync(modelPath()) }),
        setSettings: (patch) => writeSettings({ translatePrompts: !!patch.translatePrompts }),
    };
}

module.exports = { needsTranslation, buildChatPrompt, parseTranslation, pickAsset, createPromptTranslator, SYSTEM_PROMPT };
