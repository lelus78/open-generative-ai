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

module.exports = { dirSize, usage, deleteRunContaining, clearAll };
