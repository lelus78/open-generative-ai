// Generated files of local Wan2GP runs live in <runsDir>/<runId>/ (settings, logs, out/...),
// and uploaded inputs (start frames, audio) in <inputsDir>. Pure module (no electron import).
const fs = require('fs');
const path = require('path');

function dirSize(dir) {
    let total = 0;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) total += dirSize(full);
        else if (entry.isFile()) {
            try { total += fs.statSync(full).size; } catch { /* removed while scanning */ }
        }
    }
    return total;
}

function usage({ runsDir, inputsDir }) {
    return { outputsBytes: dirSize(runsDir), inputsBytes: dirSize(inputsDir) };
}

/**
 * Delete the run that produced `filePath`. Refuses anything outside runsDir, so a wrong or
 * crafted path can never remove other files. Returns whether something was deleted.
 */
function deleteRunContaining(runsDir, filePath) {
    if (!filePath || typeof filePath !== 'string') return { deleted: false };
    const root = path.resolve(runsDir);
    const target = path.resolve(filePath);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('That file is not one of the generated results.');
    }
    const runDir = path.join(root, relative.split(path.sep)[0]);
    if (!fs.existsSync(runDir)) return { deleted: false };
    fs.rmSync(runDir, { recursive: true, force: true });
    return { deleted: true };
}

/** Empty runsDir and inputsDir (the folders themselves stay). */
function clearAll({ runsDir, inputsDir }) {
    let freedBytes = 0;
    for (const dir of [runsDir, inputsDir]) {
        freedBytes += dirSize(dir);
        let entries = [];
        try { entries = fs.readdirSync(dir); } catch { /* nothing generated yet */ }
        for (const name of entries) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
    return { freedBytes };
}

/** Newest generated media files under runsDir (a run is a folder with the result inside). */
function recentResults(runsDir, limit = 10) {
    const found = [];
    const walk = (dir, depth) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { if (depth < 3) walk(full, depth + 1); continue; }
            if (!/\.(png|jpe?g|webp|mp4|webm|mkv|mov)$/i.test(entry.name)) continue;
            try { found.push({ path: full, mtime: fs.statSync(full).mtimeMs }); } catch { /* removed meanwhile */ }
        }
    };
    walk(runsDir, 0);
    return found
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, limit)
        .map(f => ({ path: f.path, modifiedAt: new Date(f.mtime).toISOString() }));
}

/**
 * A text made safe as part of a Windows/macOS/Linux file name: no reserved characters, one line, short,
 * cut at a word. Empty when nothing readable is left.
 */
function cleanLabel(text, max = 48) {
    let s = String(text || '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (s.length > max) {
        const cut = s.slice(0, max);
        s = cut.includes(' ') && cut.lastIndexOf(' ') > max / 2 ? cut.slice(0, cut.lastIndexOf(' ')) : cut;
    }
    return s.replace(/[. ]+$/, '');
}

/**
 * The folder of a new result, named so a person finds it without opening it:
 * "2026-10-27 10-39-12 - video Wan 2.1 - a fox in the snow". Date first, so the name order is the time order;
 * an ASCII separator, because the folder is handed to external tools (ffmpeg, Wan2GP).
 * The folder is not created; a name already taken gets " (2)", " (3)"…
 */
function runFolder(parent, parts, now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const name = [stamp, ...(Array.isArray(parts) ? parts : [parts]).map((p) => cleanLabel(p)).filter(Boolean)].join(' - ');
    let dir = path.join(parent, name);
    for (let i = 2; fs.existsSync(dir); i++) dir = path.join(parent, `${name} (${i})`);
    return dir;
}

module.exports = { dirSize, usage, deleteRunContaining, clearAll, recentResults, cleanLabel, runFolder };
