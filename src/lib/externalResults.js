// Results made by an AI assistant that drives the app through MCP (see electron/lib/mcpControl.js).
// They appear in Image Studio like any other result, and a small note says what the assistant is doing.
const HISTORY_KEY = 'muapi_history';
const SHOW_KEY = 'image_show_external';
const MAX_HISTORY = 50;

let toastEl = null;
let toastTimer = null;

function toast(message, { sticky = false } = {}) {
    if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.className = 'fixed bottom-5 right-5 z-[10000] max-w-sm rounded-2xl border border-primary/30 bg-[#111]/95 px-4 py-3 text-xs font-bold text-white shadow-3xl backdrop-blur-xl';
        document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 5000);
}

// The assistant's jobs, live: what it is making, how far it is, the time left and a Stop button.
// Finished jobs stay a few seconds so the user sees how they ended.
const KEEP_FINISHED_MS = 8000;
let panelEl = null;
let panelTimer = null;
let currentJobs = [];

const STATE_LABEL = { queued: 'waiting', running: 'running', done: 'done', error: 'failed', cancelled: 'stopped' };
const timeLeft = (s) => (s >= 90 ? `~${Math.round(s / 60)} min left` : `~${s} s left`);

function renderJobs() {
    const now = Date.now();
    const visible = currentJobs.filter((j) => !j.finished_at || now - j.finished_at < KEEP_FINISHED_MS);
    if (!panelEl) {
        panelEl = document.createElement('div');
        panelEl.className = 'fixed bottom-24 right-5 z-[10000] w-80 flex-col gap-2 rounded-2xl border border-primary/30 bg-[#111]/95 p-3 text-xs text-white shadow-3xl backdrop-blur-xl';
        document.body.appendChild(panelEl);
    }
    panelEl.style.display = visible.length ? 'flex' : 'none';
    panelEl.replaceChildren();
    const head = document.createElement('div');
    head.className = 'font-bold text-secondary';
    head.textContent = '🤖 Assistant jobs';
    panelEl.appendChild(head);
    for (const job of visible) {
        const row = document.createElement('div');
        row.className = 'flex flex-col gap-1';
        const line = document.createElement('div');
        line.className = 'flex items-center gap-2';
        const name = document.createElement('span');
        name.className = 'flex-1 truncate font-bold';
        name.textContent = job.name;
        name.title = job.error || job.path || job.name;
        const state = document.createElement('span');
        state.className = job.state === 'error' ? 'text-red-300' : 'text-secondary';
        state.textContent = job.state === 'running' && job.eta_seconds !== undefined ? timeLeft(job.eta_seconds) : STATE_LABEL[job.state] || job.state;
        line.append(name, state);
        if (job.state === 'queued' || job.state === 'running') {
            const stop = document.createElement('button');
            stop.type = 'button';
            stop.className = 'rounded-md bg-red-500/80 px-2 py-0.5 text-[10px] font-bold hover:bg-red-500';
            stop.textContent = 'Stop';
            stop.onclick = () => { stop.disabled = true; window.localAI?.mcp?.cancelJob(job.job_id); };
            line.appendChild(stop);
        }
        row.appendChild(line);
        if (job.state === 'running') {
            const bar = document.createElement('div');
            bar.className = 'h-1.5 overflow-hidden rounded-full bg-white/10';
            const fill = document.createElement('div');
            // no measure yet (a model loading): a thin bar that says "busy" without inventing a percentage
            fill.className = `h-full bg-primary transition-all ${job.progress === undefined ? 'animate-pulse' : ''}`;
            fill.style.width = `${job.progress === undefined ? 100 : Math.round(job.progress * 100)}%`;
            if (job.progress === undefined) fill.style.opacity = '0.35';
            bar.appendChild(fill);
            row.appendChild(bar);
            if (job.phase) {
                const phase = document.createElement('span');
                phase.className = 'text-[10px] text-muted';
                phase.textContent = `${job.phase}${job.progress !== undefined ? ` · ${Math.round(job.progress * 100)}%` : ''}`;
                row.appendChild(phase);
            }
        }
        panelEl.appendChild(row);
    }
    clearTimeout(panelTimer);
    if (visible.some((j) => j.finished_at)) panelTimer = setTimeout(renderJobs, 1000);
}

// Image Studio is not mounted yet (or never visited): put the result in its saved history; it shows it on load.
function persist(entry) {
    try {
        const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        const saved = { ...entry, url: String(entry.url || '').startsWith('data:') ? '' : entry.url };
        localStorage.setItem(HISTORY_KEY, JSON.stringify([saved, ...list].slice(0, MAX_HISTORY)));
        sessionStorage.setItem(SHOW_KEY, entry.id);
    } catch { /* storage unavailable */ }
}

function deliver(entry) {
    const detail = { entry, handled: false };
    window.dispatchEvent(new CustomEvent('local-ai:external-result', { detail }));
    if (!detail.handled) persist(entry);
    window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'image' } }));
}

// A movie project built by an assistant: the Movie tab keeps its project in localStorage, so it is written there and the tab is (re)opened.
const MOVIE_PROJECT_KEY = 'movie-project-v1';
function openMovieProject(project) {
    try { localStorage.setItem(MOVIE_PROJECT_KEY, JSON.stringify(project)); } catch { /* storage unavailable */ }
    window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'movie' } }));
    window.dispatchEvent(new CustomEvent('movie:reload-project'));
}

export function initExternalResults() {
    const api = window.localAI;
    if (!api?.onExternal) return;
    api.mcp?.jobs?.().then((list) => { currentJobs = list || []; renderJobs(); }).catch(() => {});
    api.onExternal((event) => {
        if (event.phase === 'jobs') { currentJobs = event.jobs || []; renderJobs(); }
        else if (event.phase === 'start') toast(`🤖 An assistant is working: ${event.modelName || event.label || event.tool || 'local model'}…`);
        else if (event.phase === 'error') toast(`🤖 The assistant's request failed: ${String(event.message || '').slice(0, 140)}`);
        else if (event.phase === 'result' && event.entry) { toast('🤖 An assistant added a result to Image Studio'); deliver(event.entry); }
        else if (event.phase === 'media-result') {
            const name = String(event.path || '').split(/[\x5c/]/).pop();
            toast(`🤖 An assistant made ${event.kind === 'movie' ? 'a movie' : event.kind === 'audio' ? 'a sound' : 'a clip'}: ${name} (it is in the Movie library and in the Folders)`);
        } else if (event.phase === 'movie-project' && event.project) { toast('🤖 An assistant opened a project in the Movie tab'); openMovieProject(event.project); }
    });
}

/** Image Studio asks, once loaded, which entry it should show right away (the one just made by an assistant). */
export function takeEntryToShow() {
    try {
        const id = sessionStorage.getItem(SHOW_KEY);
        sessionStorage.removeItem(SHOW_KEY);
        return id;
    } catch { return null; }
}
