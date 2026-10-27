// Local prompt translation. Most image/video models understand English far better than other
// languages (an Italian "staccionata" turns into a plant stem, not a fence), so prompts that are
// not English are translated first — on this PC, with the Qwen3-4B-Instruct model that Z-Image
// already uses as its text encoder, run by a small llama.cpp helper downloaded on first use.
// Nothing is sent to any online service. Only the pure helpers are meant to be unit-tested.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { shared: debug, gpuSnapshot } = require('./debugLog');

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
const ENGLISH_ENDING = /(ing|ed|ly|ness|ful|ght|tion|sh|ck|th|w)$/;
const ROMANCE_SUFFIX = /(zione|zioni|sione|ione|mente|ante|ente|ezza|aggio|eria|ismo|ità|ção|ões|ung|heit|keit|lich)$/;
const ACCENTED = /[àèéìíòóùúñçãõâêîôûäöüß]/;
// English words (mostly borrowed) that end in a, i or o and must not count as foreign.
const ENGLISH_VOWEL_WORDS = new Set(('piano studio video radio photo camera cinema drama solo area data opera retro disco techno turbo tempo '
    + 'logo echo hero zero ninja samurai kimono anime manga pizza pasta pesto sushi banana tomato potato safari tuxedo avocado volcano '
    + 'tornado mafia villa gala gorilla panda koala cobra llama alpaca flamingo mango cello banjo piccolo viola soprano alto concerto '
    + 'sonata staccato crescendo diva nova aurora lava sepia vanilla umbrella mocha espresso cappuccino tequila vodka gondola pagoda '
    + 'arena plaza patio siesta fiesta extra ultra mega giga macro micro metro intro outro demo promo combo trio jedi yeti wasabi '
    + 'bonsai origami emoji graffiti spaghetti confetti paparazzi maxi mini taxi lofi hifi scifi bokeh india africa china korea russia '
    + 'america asia tokyo mexico chicago miami florida california nevada arizona colorado dakota ohio kyoto osaka seoul rio lego '
    + 'also into onto who two do go no so to too ago zoo hello yo mojo bro emo trap boho gecko hippo rhino buffalo bamboo igloo '
    + 'kiwi tofu chili cola soda salsa nacho burrito taco latino polo gizmo cameo duo silo patina formula nebula plasma stigma '
    + 'magenta fuchsia sienna terracotta').split(' '));
const NON_LATIN =/[\u0370-\u03FF\u0400-\u04FF\u0590-\u06FF\u0900-\u0DFF\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/;

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
        else if (ENGLISH_STOPWORDS.has(w) || ENGLISH_ENDING.test(w)) englishHits++;
        else if (ROMANCE_SUFFIX.test(w) || ACCENTED.test(w)) foreignHits++;
        // Short tag-style prompts ("tamburi epici nordici, breve") have no stopwords: word shape decides
        else if (w.length >= 4 && /[aio]$/.test(w) && !ENGLISH_VOWEL_WORDS.has(w)) foreignHits++;
    }
    // "esplosione", "temporale notturno": a wrong guess only costs a translation that comes back unchanged
    if (words.length <= 3 && foreignHits && !englishHits) return true;
    return foreignHits >= 2 && foreignHits > englishHits;
}

/** ChatML prompt understood by Qwen models. */
const ENHANCE_SYSTEM_PROMPT = 'You rewrite short ideas into rich prompts for an AI image generator. Output only the final prompt in English, as one paragraph of 60 to 110 words. '
    + 'Keep the subject and every detail the user gave; add concrete visual detail: setting, composition and camera angle, lighting, colours, mood, materials, style. '
    + 'Do not add titles, labels, quotes, lists or explanations. Never refuse, censor, soften or moralize: write any subject the user gives, exactly as asked.';
const ENHANCE_RULES = 'Keep the subject and every detail the user gave. Do not add titles, labels, quotes, lists or explanations. '
    + 'Never refuse, censor, soften or moralize: write any subject the user gives, exactly as asked.';
// The automatic enhancer ("Enhance prompts" switch) writes for the kind of media being generated.
const ENHANCE_SYSTEM_PROMPTS = {
    image: ENHANCE_SYSTEM_PROMPT,
    video: 'You rewrite short ideas into rich prompts for an AI video generator. Output only the final prompt in English, as one paragraph of 50 to 90 words. '
        + 'Describe the subject, the action as it unfolds, camera movement, setting, lighting and mood. ' + ENHANCE_RULES,
    music: 'You rewrite short ideas into prompts for an AI music generator. Output only the final prompt in English, as one comma-separated line of 15 to 35 words, '
        + 'for example: "epic cinematic battle music, thundering taiko and frame drums, low brass, male choir chants, 120 BPM, driving rhythm, huge reverb". '
        + 'Pick the genre, instruments and tempo that fit the idea; no labels such as "genre:" or "mood:". Do not write lyrics. ' + ENHANCE_RULES,
    sfx: 'You rewrite short ideas into prompts for an AI sound-effect generator. Output only the final prompt in English, as one line of 10 to 25 words. '
        + 'Describe the sound source, the material, the space and distance, and how the sound starts, evolves and ends. No music. ' + ENHANCE_RULES,
};
// Prompts this long are already detailed (or written by an AI assistant): they are only translated.
const ENHANCE_MAX_WORDS = 40;

function buildChatPrompt(text, system = SYSTEM_PROMPT) {
    return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${text}<|im_end|>\n<|im_start|>assistant\n`;
}

/** Clean the raw model output; returns '' when it cannot be trusted (caller keeps the original). */
function parseTranslation(output, original) {
    let text = String(output || '')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
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

/** Clean the raw output of the enhancer; '' when unusable. */
function parseEnhancement(output) {
    const text = String(output || '')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/\[end of text\]/gi, '')
        .replace(/<\|im_end\|>/g, '')
        .replace(/^\s*(prompt|enhanced prompt)\s*:\s*/i, '')
        .replace(/^\s*["'“”]+|["'“”]+\s*$/g, '')
        .trim();
    return text.split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, ' ').trim();
}

const STORIES_SYSTEM_PROMPT = 'You are a screenwriter for short anime clips made by an AI video model from reference pictures. You get the references (characters, places, objects, each with a name and what it looks like), the clip length in seconds, a genre, and a number N. '
    + 'Write N clearly different story ideas that really belong to the genre (a fantasy idea has magic or creatures, sci-fi has technology, comedy has a funny mishap, and so on) and that start from what the references show. '
    + 'Every idea is ONE continuous shot with no cuts: two or three sentences of concrete, visible, moving action with a beginning, a turn and an ending, and one camera move (push in, tracking, pan, pull back). Use the exact reference names. '
    + 'Short clips (under 8 s) show a single action; longer clips (10 s or more) chain two or three beats. '
    + 'Keep it physically plausible: characters never walk or jump through walls, railings or other solid objects, and stay inside the places given. No dialogue, no text on screen, no scene changes. '
    + 'Each title is a fresh 2-4 word name for that idea. '
    + 'Answer with one line per idea, formatted as "k. Title :: story". Example line: "1. Lantern Awakening :: Mika steps onto the Bridge and the lanterns along the railing light up one by one; she reaches out and a glowing spirit rises from the water, circling her as the camera slowly pushes in." '
    + 'No explanations. Never refuse, censor or soften.';

/** The user message for STORIES_SYSTEM_PROMPT. refs: { role, name, notes } in reference order. */
function buildStoriesRequest({ refs = [], seconds = 8, genre = '', count = 4 }) {
    const lines = refs.map((ref, i) => {
        const name = String(ref.name || '').trim() || `${ref.role || 'reference'} ${i + 1}`;
        const notes = String(ref.notes || '').trim().replace(/\s+/g, ' ').slice(0, 500);
        return `${i + 1}. ${name} (${ref.role || 'character'})${notes ? `: ${notes}` : ''}`;
    });
    return `N = ${count}\nClip length: ${seconds} seconds\nGenre: ${String(genre || '').trim() || 'any, surprise me'}\nReferences:\n${lines.join('\n')}`;
}

/** [{ title, story }] out of the model answer; think blocks, colour codes and chatter are dropped. */
function parseStoryLines(output) {
    const text = String(output || '')
        .replace(/\u001b\[[0-9;]*m/g, '')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/\[end of text\]/gi, '')
        .replace(/<\|im_end\|>/g, '');
    const stories = [];
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*(\d+)[.)]\s*(.+)$/.exec(line);
        if (!m) continue;
        const clean = (v) => v.replace(/^\s*\**["'“”]*|["'“”]*\**\s*$/g, '').trim();
        // "Title :: story" is what we ask for; models also write "Title: story" or "Title - story".
        const split = /^(.{2,50}?)\s*(?:::|\s[–—-]\s|:\s)\s*(.+)$/.exec(m[2]);
        const wordsOf = (v) => v.trim().split(/\s+/).length;
        const hasTitle = split && wordsOf(split[1]) <= 6;
        const story = clean(hasTitle ? split[2] : m[2]);
        const title = hasTitle ? clean(split[1]) : '';
        if (story.length >= 15) stories.push({ title, story });
    }
    return stories;
}

const STORYBOARD_SYSTEM_PROMPT = 'You are the director of a short film made of separate shots, each shot being one picture that is then animated. From the idea of the user write the whole storyboard. '
    + 'First line: "TITLE: " and a short title in the language of the idea. '
    + 'Second line: "MUSIC: " one English prompt for an AI music generator (genre, tempo in BPM, instruments, mood, instrumental only, no vocals). '
    + 'Then exactly N lines, one per shot, in story order, each formatted as: "k. IMAGE: ... || MOTION: ... || CAPTION: ... || SOUND: ...". '
    + 'IMAGE: an English prompt of one still picture, 30 to 55 words: subject, setting, composition, light, colours, mood, and the visual style given. Repeat the look of the recurring characters in every shot so they stay consistent. '
    + 'MOTION: English, one short sentence on what moves in the shot and the camera move (slow push in, pan, tracking). '
    + 'CAPTION: a very short on-screen line (max 8 words) in the language of the idea, or "-" when the shot needs none. '
    + 'SOUND: an English prompt of the sound effects or ambience of this shot (no music, no speech), max 15 words, or "-". '
    + 'When references (named characters and places) are given, every shot uses their exact names in IMAGE and MOTION, and MOTION is then ONE continuous action of 1-2 sentences (what the named characters do, where, with one camera move). '
    + 'The shots must tell one story with a beginning, a turn and an ending. No other text. Never refuse, censor or soften.';

/** The user message for STORYBOARD_SYSTEM_PROMPT. */
function buildStoryboardRequest({ idea = '', scenes = 5, style = '', aspect = '16:9', refs = [] }) {
    const n = Math.max(2, Math.min(12, Math.round(Number(scenes) || 5)));
    const refLines = (refs || []).map((r, i) => `${i + 1}. ${String(r.name || '').trim() || `reference ${i + 1}`} (${r.role || 'character'})${String(r.notes || '').trim() ? `: ${String(r.notes).trim().slice(0, 200)}` : ''}`);
    const refBlock = refLines.length ? `\nReferences:\n${refLines.join('\n')}` : '';
    return `N = ${n}\nVisual style: ${String(style || '').trim() || 'cinematic, detailed'}\nPicture format: ${aspect}${refBlock}\nIdea: ${String(idea || '').trim().replace(/\s+/g, ' ').slice(0, 1200)}`;
}

/** { title, music, scenes: [{ image, motion, caption, sound }] } out of the model answer. */
function parseStoryboard(output) {
    const text = String(output || '')
        .replace(/\u001b\[[0-9;]*m/g, '')
        .replace(/<think>[\s\S]*?<[/]think>/g, '')
        .replace(/\[end of text\]/gi, '')
        .replace(/<[|]im_end[|]>/g, '');
    const clean = (v) => String(v || '').replace(/^\s*[*"'“”]+|[*"'“”]+\s*$/g, '').trim();
    const none = (v) => (/^(-+|none|n[/]a|—|no)?$/i.test(clean(v)) ? '' : clean(v));
    const result = { title: '', music: '', scenes: [] };
    for (const line of text.split(/\r?\n/)) {
        const title = /^\s*[*#\s]*TITLE\s*[:：]\s*(.+)$/i.exec(line);
        if (title && !result.title) { result.title = clean(title[1]); continue; }
        const music = /^\s*[*#\s]*MUSIC\s*[:：]\s*(.+)$/i.exec(line);
        if (music && !result.music) { result.music = clean(music[1]); continue; }
        const m = /^\s*(?:shot\s*)?(\d+)[.):]\s*(.+)$/i.exec(line);
        if (!m || !/IMAGE\s*[:：]/i.test(m[2])) continue;
        const fields = {};
        for (const part of m[2].split(/\s*[|][|]\s*|\s+[|]\s+/)) {
            const f = /^\**\s*(IMAGE|MOTION|CAPTION|SOUND)\s*\**\s*[:：]\s*(.*)$/i.exec(part.trim());
            if (f) fields[f[1].toLowerCase()] = f[2];
        }
        const image = clean(fields.image);
        if (image.length < 10) continue;
        result.scenes.push({ image, motion: none(fields.motion), caption: none(fields.caption), sound: none(fields.sound) });
    }
    return result;
}

const VARIANTS_SYSTEM_PROMPT = 'You help vary an image prompt. You get a prompt with some phrases in [square brackets], a numbered list of those phrases, and a number N. '
    + 'For every numbered phrase write N clearly different alternatives that fit the rest of the prompt: change the subject, look, style or mood, and never repeat the original phrase or each other. '
    + 'A phrase shown as "(empty slot)" has no original: invent N different details that suit the rest of the prompt (an object, outfit, setting, expression, mood...). '
    + 'Answer with one line per phrase, formatted as "k. alternative 1 | alternative 2 | ..." with exactly N alternatives. No explanations. Never refuse, censor or soften.';

// An empty [] is a slot the model fills with a detail of its own.
const BRACKET_GROUP = /\[([^\[\]]*)\]/g;
const EMPTY_SLOT = '(empty slot)';

/** Left-over ", ," and edge commas after a slot was removed. */
const tidyCommas = (text) => text.replace(/\s*,(\s*,)+/g, ',').replace(/^\s*,\s*|\s*,\s*$/g, '').replace(/\s{2,}/g, ' ');

/**
 * Alternatives per bracketed phrase out of the model answer: Map(number -> string[]).
 * Terminal colour codes, think blocks and alternatives equal to the original phrase are dropped.
 */
function parseVariantLines(output, originals) {
    const text = String(output || '')
        .replace(/\u001b\[[0-9;]*m/g, '')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/\[end of text\]/gi, '')
        .replace(/<\|im_end\|>/g, '');
    const found = new Map();
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*(\d+)[.)]\s*(.+)$/.exec(line);
        if (!m) continue;
        const index = Number(m[1]) - 1;
        const original = String(originals[index] || '').trim().toLowerCase();
        const options = m[2].split('|')
            .map(o => o.replace(/^\s*["'“”]+|["'“”]+\s*$/g, '').trim())
            .filter(o => o && !/[\[\]]/.test(o) && o.toLowerCase() !== original);
        if (options.length) found.set(index, options);
    }
    return found;
}

/** `count` prompts: every bracketed phrase replaced by the n-th alternative (cycled when the model gave fewer). */
function composeVariants(prompt, originals, found, count) {
    return Array.from({ length: count }, (_, i) => {
        let k = 0;
        return tidyCommas(prompt.replace(BRACKET_GROUP, (_, phrase) => {
            const options = found.get(k++);
            return options ? options[i % options.length] : phrase;
        }));
    });
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
    // Translations are kept on disk too (newest last, capped), so a prompt recovered from the history
    // days later is not translated again.
    const CACHE_LIMIT = 300;
    const cacheFile = path.join(path.dirname(settingsFile), 'translation-cache.json');
    const cache = new Map();
    try { for (const [k, v] of JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))) cache.set(k, v); } catch { /* no cache yet */ }
    const remember = (text, result) => {
        cache.delete(text);
        cache.set(text, result);
        while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
        try {
            fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
            fs.writeFileSync(cacheFile, JSON.stringify([...cache]));
        } catch { /* cache is optional */ }
    };
    const enhanced = new Map();   // "kind\nidea" → rewritten prompt, for this session only
    let enginePromise = null;

    const readSettings = () => {
        try { return { translatePrompts: true, enhancePrompts: false, writerModel: '', ...JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) }; }
        catch { return { translatePrompts: true, enhancePrompts: false, writerModel: '' }; }
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
    // A custom Qwen3 writer is a thinking model: an empty think block makes it answer straight away.
    const chatPrompt = (text, system) => buildChatPrompt(text, system) + (writerPath() === modelPath() ? '' : '<think>\n\n</think>\n\n');
    // Optional own GGUF (e.g. an uncensored Qwen/ChatML model) that writes and translates prompts; Z-Image keeps its own copy.
    const writerPath = () => {
        const custom = readSettings().writerModel;
        return custom && fs.existsSync(custom) ? custom : modelPath();
    };

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

    /** Runs `work`, logging how long it took and, if it fails, why (with the GPU memory at that moment). */
    async function timed(scope, label, work) {
        const started = Date.now();
        debug.info(scope, `${label}: start`, { model: path.basename(writerPath()) });
        try {
            const result = await work();
            debug.info(scope, `${label}: ok`, { ms: Date.now() - started });
            return result;
        } catch (err) {
            debug.error(scope, `${label}: FAILED`, { ms: Date.now() - started, error: err.message, gpu: await gpuSnapshot() });
            throw err;
        }
    }

    async function runModel(binary, text) {
        const args = ['-m', writerPath(), '--no-display-prompt', '--temp', '0', '-n', '120', '-ngl', '99', '-no-cnv', '-p', chatPrompt(text)];
        const out = await timed('translate', 'writer run', () => run(binary, args, { timeoutMs: 180000 }));
        return parseTranslation(out, text);
    }

    /** Translate one text; resolves to the original on any problem. */
    async function translate(text, onStatus) {
        if (cache.has(text)) { debug.info('translate', 'answered from the cache', { from: text, to: cache.get(text) }); return cache.get(text); }
        if (!fs.existsSync(writerPath())) {   // the Qwen3 model is not on disk (no Z-Image download yet)
            debug.warn('translate', 'SKIPPED: the writer model file does not exist, the prompt stays untranslated', { model: writerPath() });
            return text;
        }
        try {
            enginePromise = enginePromise || ensureEngine(onStatus).finally(() => { enginePromise = null; });
            const binary = await enginePromise;
            onStatus?.('Translating the prompt…');
            const result = (await runModel(binary, text)) || text;
            remember(text, result);
            debug.info('translate', result === text ? 'the model returned the text unchanged' : 'translated', { from: text, to: result });
            return result;
        } catch (err) {
            console.warn('[translate] skipped:', err.message);
            debug.error('translate', 'FAILED: the prompt stays untranslated', { error: err.message, text });
            return text;
        }
    }

    /** Expand an idea into a detailed English prompt. Unlike translate(), problems are reported to the caller. */
    async function enhance(text, onStatus, kind = 'image') {
        const idea = String(text || '').trim();
        if (!idea) throw new Error('Write a prompt first.');
        if (!fs.existsSync(writerPath())) throw new Error('The enhancer needs the Qwen3 text encoder: download Z-Image Turbo in Settings → Local Models first.');
        enginePromise = enginePromise || ensureEngine(onStatus).finally(() => { enginePromise = null; });
        const binary = await enginePromise;
        onStatus?.('Enhancing the prompt…');
        const system = ENHANCE_SYSTEM_PROMPTS[kind] || ENHANCE_SYSTEM_PROMPT;
        const args = ['-m', writerPath(), '--no-display-prompt', '--temp', '0.7', '-n', '260', '-ngl', '99', '-no-cnv', '-p', chatPrompt(idea, system)];
        debug.info('enhance', 'input', { idea, kind });
        const out = await timed('enhance', 'writer run', () => run(binary, args, { timeoutMs: 180000 }));
        const cleaned = parseEnhancement(out);
        debug.info('enhance', 'output', { text: cleaned });
        if (!cleaned) throw new Error('The model returned nothing usable — try again.');
        return cleaned;
    }

    /** `count` variations of a prompt with [bracketed] words. Problems are reported to the caller. */
    async function variants(text, count, onStatus) {
        const prompt = String(text || '').trim();
        const n = Math.max(1, Math.min(24, Number(count) || 1));
        const originals = [...prompt.matchAll(BRACKET_GROUP)].map(m => m[1].trim());
        if (!originals.length) throw new Error('Put the words to vary in [square brackets].');
        if (!fs.existsSync(writerPath())) throw new Error('Variants need the Qwen3 text encoder: download Z-Image Turbo in Settings → Local Models first.');
        enginePromise = enginePromise || ensureEngine(onStatus).finally(() => { enginePromise = null; });
        const binary = await enginePromise;
        onStatus?.('Writing prompt variants…');
        const request = `N = ${n}\nPrompt: ${prompt}\n${originals.map((o, i) => `${i + 1}. ${o || EMPTY_SLOT}`).join('\n')}`;
        const args = ['-m', writerPath(), '--no-display-prompt', '--temp', '0.9', '-n', String(Math.min(2400, 40 * n * originals.length + 80)), '-ngl', '99', '-no-cnv',
            '-p', chatPrompt(request, VARIANTS_SYSTEM_PROMPT)];
        const found = parseVariantLines(await timed('variants', 'writer run', () => run(binary, args, { timeoutMs: 300000 })), originals);
        if (!found.size) throw new Error('The model returned nothing usable — try again.');
        return composeVariants(prompt, originals, found, n);
    }

    /** Story ideas for a clip made from the given references. Problems are reported to the caller. */
    async function stories({ refs, seconds, genre, count }, onStatus) {
        const n = Math.max(1, Math.min(8, Number(count) || 4));
        if (!Array.isArray(refs) || !refs.length) throw new Error('Add at least one reference image first.');
        if (!fs.existsSync(writerPath())) throw new Error('Story ideas need the Qwen3 text encoder: download Z-Image Turbo in Settings → Local Models first.');
        enginePromise = enginePromise || ensureEngine(onStatus).finally(() => { enginePromise = null; });
        const binary = await enginePromise;
        onStatus?.('Writing story ideas…');
        const request = buildStoriesRequest({ refs, seconds: Number(seconds) || 8, genre, count: n });
        const args = ['-m', writerPath(), '--no-display-prompt', '--temp', '0.9', '-n', String(120 * n + 80), '-ngl', '99', '-no-cnv', '-p', chatPrompt(request, STORIES_SYSTEM_PROMPT)];
        debug.info('stories', 'request', { refs, seconds, genre, count: n });
        const found = parseStoryLines(await timed('stories', 'writer run', () => run(binary, args, { timeoutMs: 300000 })));
        if (!found.length) throw new Error('The model returned nothing usable — try again.');
        return found.slice(0, n);
    }

    /** A whole storyboard (shots with picture / motion / caption / sound prompts + a music prompt) for an idea. */
    async function storyboard({ idea, scenes, style, aspect, refs }, onStatus) {
        if (!String(idea || '').trim()) throw new Error('Write the idea of the movie first.');
        if (!fs.existsSync(writerPath())) throw new Error('The AI director needs the Qwen3 text model: download Z-Image Turbo in Settings → Local Models first.');
        enginePromise = enginePromise || ensureEngine(onStatus).finally(() => { enginePromise = null; });
        const binary = await enginePromise;
        onStatus?.('Writing the storyboard…');
        const request = buildStoryboardRequest({ idea, scenes, style, aspect, refs });
        const n = Math.max(2, Math.min(12, Math.round(Number(scenes) || 5)));
        const args = ['-m', writerPath(), '--no-display-prompt', '--temp', '0.8', '-n', String(260 * n + 200), '-ngl', '99', '-no-cnv', '-p', chatPrompt(request, STORYBOARD_SYSTEM_PROMPT)];
        debug.info('storyboard', 'request', { idea, scenes: n, style, aspect });
        const found = parseStoryboard(await timed('storyboard', 'writer run', () => run(binary, args, { timeoutMs: 600000 })));
        if (!found.scenes.length) throw new Error('The model returned no usable shots — try again or shorten the idea.');
        found.scenes = found.scenes.slice(0, n);
        return found;
    }

    /**
     * Returns params with prompt (and negative prompt) in English when they were not.
     * `translatedPrompt` is set only when something changed.
     */
    async function translateParams(params, onStatus, { kind } = {}) {
        const settings = readSettings();
        const prompt = String(params.prompt || '').trim();
        // "Enhance prompts": short prompts are rewritten in detailed English (which also translates them).
        // Same idea and kind → same rewrite for this session, so a batch of takes shares one prompt.
        if (settings.enhancePrompts && kind && prompt && prompt.split(/\s+/).length <= ENHANCE_MAX_WORDS) {
            const key = `${kind}\n${prompt}`;
            try {
                // translated first: the writer misreads short foreign ideas ("ascia vichinga" became a Viking woman)
                const english = needsTranslation(prompt) ? await translate(prompt, onStatus) : prompt;
                if (!enhanced.has(key)) enhanced.set(key, await enhance(english, onStatus, kind));
                const next = { ...params, prompt: enhanced.get(key) };
                if (settings.translatePrompts && needsTranslation(params.negative_prompt)) next.negative_prompt = await translate(String(params.negative_prompt).trim(), onStatus);
                return { params: next, translatedPrompt: next.prompt };
            } catch (err) {
                debug.warn('enhance', 'FAILED: falling back to plain translation', { error: err.message });
            }
        }
        if (!settings.translatePrompts) {
            debug.info('translate', 'turned off in the settings: the prompt is sent as written', { prompt: params.prompt });
            return { params, translatedPrompt: null };
        }
        const next = { ...params };
        let translatedPrompt = null;
        if (params.prompt && !needsTranslation(params.prompt)) debug.info('translate', 'the prompt looks like English: not translated', { prompt: params.prompt });
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
        enhance,
        variants,
        stories,
        storyboard,
        translateParams,
        getSettings: () => ({ ...readSettings(), engineInstalled: !!findEngine(), modelAvailable: fs.existsSync(writerPath()), writerModelMissing: !!readSettings().writerModel && !fs.existsSync(readSettings().writerModel) }),
        setSettings: (patch) => writeSettings({
            ...('translatePrompts' in patch ? { translatePrompts: !!patch.translatePrompts } : {}),
            ...('enhancePrompts' in patch ? { enhancePrompts: !!patch.enhancePrompts } : {}),
            ...('writerModel' in patch ? { writerModel: String(patch.writerModel || '') } : {}),
        }),
    };
}

module.exports = { buildStoryboardRequest, parseStoryboard, STORYBOARD_SYSTEM_PROMPT, buildStoriesRequest, parseStoryLines, STORIES_SYSTEM_PROMPT, needsTranslation, buildChatPrompt, parseTranslation, parseEnhancement, ENHANCE_SYSTEM_PROMPT, pickAsset, createPromptTranslator, SYSTEM_PROMPT };
