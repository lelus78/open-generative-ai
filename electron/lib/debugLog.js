// Debug log shared by the whole desktop app: what was asked, what each local tool did, and why something
// failed. A bounded in-memory list (shown in the Debug panel) plus a log file that rotates, so a problem can
// be understood after the fact. Pure module (no electron import): the app points it at a file via configure().
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const LEVELS = ['info', 'warn', 'error'];

function createDebugLog({ file = null, max = 1000, maxFileBytes = 2 * 1024 * 1024, now = () => Date.now() } = {}) {
    let entries = [];
    let seq = 0;
    let verbose = false;
    let filePath = file;
    const listeners = new Set();

    // Long strings (prompts, console output) are clipped, much less so in verbose mode.
    const clip = (value, limit) => (typeof value === 'string' && value.length > limit ? `${value.slice(0, limit)}… [+${value.length - limit} chars]` : value);
    function sanitize(value, limit, depth = 0) {
        if (value instanceof Error) return { error: value.message, stack: clip(value.stack || '', limit) };
        if (typeof value === 'string') return clip(value, limit);
        if (Array.isArray(value)) return depth > 3 ? '[…]' : value.slice(0, 50).map((item) => sanitize(item, limit, depth + 1));
        if (value && typeof value === 'object') {
            if (depth > 3) return '[…]';
            if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[${value.length} bytes]`;
            return Object.fromEntries(Object.entries(value).slice(0, 60).map(([k, v]) => [k, sanitize(v, limit, depth + 1)]));
        }
        return value;
    }

    function writeToFile(entry) {
        if (!filePath) return;
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            if (fs.existsSync(filePath) && fs.statSync(filePath).size > maxFileBytes) fs.renameSync(filePath, `${filePath}.1`);
            fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
        } catch { /* a log must never break the app */ }
    }

    function add(level, scope, message, data) {
        const entry = {
            id: ++seq, t: now(), level: LEVELS.includes(level) ? level : 'info', scope: String(scope || 'app'), message: String(message || ''),
            ...(data === undefined ? {} : { data: sanitize(data, verbose ? 20000 : 1500) }),
        };
        entries.push(entry);
        if (entries.length > max) entries = entries.slice(-max);
        writeToFile(entry);
        for (const listener of listeners) { try { listener(entry); } catch { /* ignore a broken listener */ } }
        return entry;
    }

    return {
        info: (scope, message, data) => add('info', scope, message, data),
        warn: (scope, message, data) => add('warn', scope, message, data),
        error: (scope, message, data) => add('error', scope, message, data),
        entries: () => entries.slice(),
        clear: () => { entries = []; },
        onEntry: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        setVerbose: (value) => { verbose = !!value; },
        isVerbose: () => verbose,
        setFile: (next) => { filePath = next; },
        getFile: () => filePath,
    };
}

const pad = (n, size = 2) => String(n).padStart(size, '0');

/** One line per entry, with the data on the following lines: easy to paste into a bug report. */
function formatEntries(entries) {
    return entries.map((entry) => {
        const d = new Date(entry.t);
        const stamp = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
        const head = `[${stamp}] ${entry.level.toUpperCase().padEnd(5)} ${entry.scope}: ${entry.message}`;
        if (entry.data === undefined) return head;
        const body = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2);
        return `${head}\n${body.split('\n').map((line) => `    ${line}`).join('\n')}`;
    }).join('\n');
}

/** "used / total MiB" of the GPU right now, or null when nvidia-smi is not there (other GPUs, other systems). */
function gpuSnapshot() {
    return new Promise((resolve) => {
        execFile('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 3000, windowsHide: true }, (err, stdout) => {
            if (err) return resolve(null);
            const [used, total] = String(stdout).trim().split(/\s*,\s*/).map(Number);
            resolve(Number.isFinite(used) && Number.isFinite(total) ? { usedMiB: used, totalMiB: total, freeMiB: total - used } : null);
        });
    });
}

const shared = createDebugLog();

module.exports = { createDebugLog, formatEntries, gpuSnapshot, shared };
