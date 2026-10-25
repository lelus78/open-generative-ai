// Debug log window: what the app asked, what each local tool answered, and why something failed.
// Lines come from the desktop app (translation, prompt enhancer, image and video generation) and
// arrive live. "Copy all" gives a text that can be pasted straight into a bug report.

const LEVEL_STYLE = {
    info: 'text-white/60',
    warn: 'text-yellow-300',
    error: 'text-red-400',
};

const api = () => window.localAI?.debug;

export const isDebugAvailable = () => !!api();

const pad = (n, size = 2) => String(n).padStart(size, '0');
const stamp = (t) => {
    const d = new Date(t);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

let openPanel = null;

export function openDebugPanel() {
    if (openPanel) { openPanel.remove(); openPanel = null; return; }   // the shortcut toggles it
    const debug = api();
    if (!debug) return;

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4';
    overlay.innerHTML = `
        <div class="w-full max-w-6xl h-[85vh] rounded-2xl bg-[#0d0d0d] border border-white/10 shadow-2xl flex flex-col overflow-hidden">
            <div class="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-white/10">
                <h2 class="text-sm font-bold">Debug log</h2>
                <span class="dbg-count text-[11px] text-secondary"></span>
                <div class="dbg-levels flex gap-1 ml-2"></div>
                <input class="dbg-search min-w-[140px] flex-1 max-w-xs rounded-lg bg-white/5 border border-white/10 px-3 py-1.5 text-xs outline-none focus:border-primary/60" placeholder="Search…">
                <label class="flex items-center gap-1.5 text-[11px] text-secondary ml-auto" title="Keeps whole prompts and console output instead of clipping them. Turn it on, repeat the problem, then copy the log."><input type="checkbox" class="dbg-verbose accent-primary"> Verbose</label>
                <button class="dbg-copy px-3 py-1.5 rounded-lg bg-primary/20 border border-primary/40 text-primary text-xs font-bold hover:bg-primary/30">Copy all</button>
                <button class="dbg-folder px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold">Open log file</button>
                <button class="dbg-clear px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold">Clear</button>
                <button class="dbg-close w-8 h-8 rounded-lg bg-white/10 hover:bg-white/15 text-sm" title="Close (Esc)">✕</button>
            </div>
            <div class="dbg-scopes flex flex-wrap gap-1.5 px-4 py-2 border-b border-white/5"></div>
            <div class="dbg-list flex-1 overflow-y-auto custom-scrollbar font-mono text-[11.5px] leading-relaxed px-2 py-2"></div>
            <div class="dbg-hint px-4 py-2 border-t border-white/5 text-[11px] text-secondary"></div>
        </div>`;
    document.body.appendChild(overlay);
    openPanel = overlay;

    const $ = (selector) => overlay.querySelector(selector);
    const list = $('.dbg-list');
    let entries = [];
    let level = 'all';          // 'all' | 'problems'
    let scope = '';             // '' = every scope
    let query = '';
    let file = '';

    const visible = (entry) => (level === 'all' || entry.level !== 'info')
        && (!scope || entry.scope === scope)
        && (!query || `${entry.scope} ${entry.message} ${JSON.stringify(entry.data || '')}`.toLowerCase().includes(query));

    function rowFor(entry) {
        const row = document.createElement('div');
        row.className = 'rounded px-2 py-0.5 hover:bg-white/5';
        const head = document.createElement('div');
        head.className = 'flex gap-2 cursor-pointer';
        const time = Object.assign(document.createElement('span'), { className: 'text-white/35 shrink-0', textContent: stamp(entry.t) });
        const lvl = Object.assign(document.createElement('span'), { className: `shrink-0 w-10 font-bold uppercase ${LEVEL_STYLE[entry.level] || ''}`, textContent: entry.level });
        const sc = Object.assign(document.createElement('span'), { className: 'shrink-0 text-primary/80', textContent: entry.scope });
        const msg = Object.assign(document.createElement('span'), { className: `min-w-0 break-words ${LEVEL_STYLE[entry.level] || 'text-white/90'}`, textContent: entry.message });
        head.append(time, lvl, sc, msg);
        row.appendChild(head);
        if (entry.data !== undefined) {
            const body = document.createElement('pre');
            body.className = 'hidden mt-1 ml-[7.5rem] p-2 rounded bg-black/50 border border-white/5 whitespace-pre-wrap break-words text-white/75';
            body.textContent = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2);
            row.appendChild(body);
            msg.textContent = `${entry.message}  ▸`;
            head.onclick = () => body.classList.toggle('hidden');
            if (entry.level === 'error') body.classList.remove('hidden'); // problems open by themselves
        }
        return row;
    }

    function renderScopes() {
        const box = $('.dbg-scopes');
        box.innerHTML = '';
        const names = [...new Set(entries.map((e) => e.scope))].sort();
        for (const name of ['', ...names]) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.textContent = name || 'all scopes';
            chip.className = `px-2 py-0.5 rounded-full border text-[11px] ${scope === name ? 'bg-primary/20 border-primary/40 text-primary' : 'bg-white/5 border-white/10 text-secondary hover:text-white'}`;
            chip.onclick = () => { scope = name; renderScopes(); renderList(); };
            box.appendChild(chip);
        }
    }

    function renderList() {
        list.innerHTML = '';
        const shown = entries.filter(visible);
        for (const entry of shown) list.appendChild(rowFor(entry));
        list.scrollTop = list.scrollHeight;
        $('.dbg-count').textContent = `${shown.length} of ${entries.length} lines`;
        $('.dbg-hint').textContent = file ? `Saved to ${file}` : '';
    }

    function renderLevels() {
        const box = $('.dbg-levels');
        box.innerHTML = '';
        for (const [id, label] of [['all', 'All'], ['problems', 'Warnings & errors']]) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = label;
            btn.className = `px-2.5 py-1 rounded-lg text-[11px] font-semibold ${level === id ? 'bg-white/15 text-white' : 'bg-white/5 text-secondary hover:text-white'}`;
            btn.onclick = () => { level = id; renderLevels(); renderList(); };
            box.appendChild(btn);
        }
    }

    const unsubscribe = debug.onEntry((entry) => {
        entries.push(entry);
        if (!entries.some((e, i) => i < entries.length - 1 && e.scope === entry.scope)) renderScopes();
        if (!visible(entry)) { $('.dbg-count').textContent = `${list.children.length} of ${entries.length} lines`; return; }
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
        list.appendChild(rowFor(entry));
        if (atBottom) list.scrollTop = list.scrollHeight;
        $('.dbg-count').textContent = `${list.children.length} of ${entries.length} lines`;
    });

    function close() {
        unsubscribe();
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        openPanel = null;
    }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    $('.dbg-close').onclick = close;

    $('.dbg-search').oninput = (e) => { query = e.target.value.trim().toLowerCase(); renderList(); };
    $('.dbg-verbose').onchange = (e) => debug.setVerbose(e.target.checked);
    $('.dbg-clear').onclick = async () => { await debug.clear(); entries = []; renderScopes(); renderList(); };
    $('.dbg-folder').onclick = () => debug.openFolder();
    $('.dbg-copy').onclick = async () => {
        const button = $('.dbg-copy');
        try {
            await navigator.clipboard.writeText(await debug.text());
            button.textContent = 'Copied ✓';
        } catch { button.textContent = 'Copy failed'; }
        setTimeout(() => { button.textContent = 'Copy all'; }, 1800);
    };

    renderLevels();
    debug.get().then((state) => {
        // Lines that arrived while the list was loading are already in `entries`; keep both without repeats.
        const seen = new Set(state.entries.map((e) => e.id));
        entries = [...state.entries, ...entries.filter((e) => !seen.has(e.id))];
        file = state.file || '';
        $('.dbg-verbose').checked = !!state.verbose;
        renderScopes();
        renderList();
    });
}
