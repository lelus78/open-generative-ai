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

export function initExternalResults() {
    const api = window.localAI;
    if (!api?.onExternal) return;
    api.onExternal((event) => {
        if (event.phase === 'start') toast(`🤖 An assistant is working: ${event.modelName || 'local model'}…`, { sticky: true });
        else if (event.phase === 'error') toast(`🤖 The assistant's request failed: ${String(event.message || '').slice(0, 140)}`);
        else if (event.phase === 'result' && event.entry) { toast('🤖 An assistant added a result to Image Studio'); deliver(event.entry); }
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
