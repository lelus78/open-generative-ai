import { t } from '../lib/i18n.js';
import { sendToMovie } from '../lib/movieHandoff.js';
import { createPromptSwitches, reviewEnhancedPrompt } from '../lib/studioHelpers.js';

// Music creator: instrumental music and sound effects from a text description, made on this PC with
// Stable Audio 3 through Wan2GP. Results can be listened to, saved, and sent to the Movie as its soundtrack.

const HISTORY_KEY = 'music-history-v1';
const HISTORY_MAX = 40;
const KINDS = {
    music: {
        label: 'Music', model: 'wan2gp:stable-audio3-music', min: 5, max: 120, step: 5, def: 30,
        placeholder: 'Genre, tempo, instruments, mood. e.g. Epic orchestral trailer music, taiko drums, brass fanfare, 100 BPM, heroic. Any language.',
        chips: ['Epic orchestral, taiko drums, heroic', 'Lo-fi chill beat, vinyl crackle, 80 BPM', 'Dark ambient pads, slow and eerie', 'Upbeat synthwave, 120 BPM, arpeggios', 'Warm acoustic guitar, folk, gentle', 'Cinematic tension, low strings, pulse', 'Techno, 128 BPM, driving bass', 'Peaceful piano, soft and slow'],
    },
    sfx: {
        label: 'Sound effects', model: 'wan2gp:stable-audio3-sfx', min: 2, max: 30, step: 1, def: 6,
        placeholder: 'A sound event or an ambience. e.g. Sword clash with a long metal ring and echo. Any language.',
        chips: ['Sword clash, metal ring, echo', 'Wind howling over an open plain', 'Heavy footsteps on gravel', 'Whoosh into a deep cinematic impact', 'Crowd cheering in a stadium', 'Rain and distant thunder', 'Door creak, spooky ambience', 'Laser blast, sci-fi'],
    },
};

const api = () => window.localAI?.wan2gp;
const files = () => window.localAI?.movie;
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const escapeHtml = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } }
function saveHistory(list) { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX))); } catch { /* storage unavailable */ } }

export function MusicStudio() {
    const container = document.createElement('div');
    container.className = 'w-full h-full overflow-y-auto custom-scrollbar bg-app-bg text-white';
    const inner = document.createElement('div');
    inner.className = 'max-w-5xl mx-auto px-4 md:px-6 py-8 flex flex-col gap-6';
    container.appendChild(inner);

    if (!api() || !files()) {
        inner.innerHTML = '<p class="text-secondary">The music creator runs in the desktop app only.</p>';
        return container;
    }

    let kind = 'music';
    let history = loadHistory();
    let running = false;
    let stopped = false;
    let unsubscribe = null;

    inner.innerHTML = `
        <div class="flex flex-col gap-1">
            <h1 class="text-3xl font-bold tracking-tight">${t('nav.music')}</h1>
            <p class="text-secondary text-sm">Make music and sound effects from a description, on this PC (Stable Audio 3 through Wan2GP). Listen, save, or send the result to the Movie as its soundtrack.</p>
        </div>
        <div class="mu-setup hidden rounded-2xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm"></div>
        <section class="flex flex-col gap-4">
            <div class="flex gap-2">
                <button class="mu-kind px-4 py-2 rounded-xl text-sm font-bold border" data-kind="music">🎵 Music</button>
                <button class="mu-kind px-4 py-2 rounded-xl text-sm font-bold border" data-kind="sfx">🔊 Sound effects</button>
            </div>
            <textarea class="mu-prompt w-full min-h-[96px] rounded-xl bg-white/5 border border-white/10 p-3 text-sm outline-none focus:border-primary/60"></textarea>
            <div class="mu-chips flex flex-wrap gap-1.5"></div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
                <label class="flex flex-col gap-1 text-xs text-secondary col-span-2">Length: <b class="mu-len-label text-white"></b> s
                    <input type="range" class="mu-len accent-primary"></label>
                <label class="flex flex-col gap-1 text-xs text-secondary">Versions
                    <select class="mu-count rounded-lg bg-white/5 border border-white/10 px-2 py-2 text-sm text-white"><option value="1">1</option><option value="2">2</option><option value="3">3</option></select></label>
                <label class="flex flex-col gap-1 text-xs text-secondary">Seed (empty = random)
                    <input class="mu-seed rounded-lg bg-white/5 border border-white/10 px-2 py-2 text-sm text-white" inputmode="numeric" placeholder="random"></label>
            </div>
            <div class="flex flex-wrap items-center gap-3">
                <button class="mu-go px-6 py-3 rounded-xl bg-primary text-black font-bold text-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">Create</button>
                <button class="mu-stop hidden px-5 py-3 rounded-xl bg-red-500/90 text-white font-bold text-sm hover:bg-red-500">Stop</button>
                <span class="mu-status text-xs text-secondary"></span>
            </div>
            <div class="mu-progress hidden h-2 rounded-full bg-white/10 overflow-hidden"><div class="mu-bar h-full bg-primary transition-all" style="width:0%"></div></div>
            <div class="mu-error hidden rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200 whitespace-pre-wrap break-words"></div>
        </section>
        <section class="flex flex-col gap-2">
            <div class="flex items-center gap-3"><h2 class="text-xs font-bold uppercase tracking-widest text-secondary">Your sounds</h2>
                <button class="mu-folder ml-auto text-xs text-secondary hover:text-white underline">Open the folder</button></div>
            <div class="mu-history flex flex-col gap-2"></div>
        </section>`;

    const $ = (s) => inner.querySelector(s);
    const els = {
        setup: $('.mu-setup'), prompt: $('.mu-prompt'), chips: $('.mu-chips'), len: $('.mu-len'), lenLabel: $('.mu-len-label'), count: $('.mu-count'),
        seed: $('.mu-seed'), go: $('.mu-go'), stop: $('.mu-stop'), status: $('.mu-status'), progress: $('.mu-progress'), bar: $('.mu-bar'),
        error: $('.mu-error'), history: $('.mu-history'), folder: $('.mu-folder'),
    };
    const promptSwitches = createPromptSwitches();
    if (promptSwitches) els.prompt.after(promptSwitches);
    const showError = (message) => { els.error.textContent = message || ''; els.error.classList.toggle('hidden', !message); };

    // ── Kind (music / sound effects) ─────────────────────────────
    function applyKind() {
        const k = KINDS[kind];
        inner.querySelectorAll('.mu-kind').forEach((b) => {
            const on = b.dataset.kind === kind;
            b.className = `mu-kind px-4 py-2 rounded-xl text-sm font-bold border ${on ? 'bg-primary/20 border-primary/50 text-primary' : 'bg-white/5 border-white/10 text-secondary hover:text-white'}`;
        });
        els.prompt.placeholder = k.placeholder;
        els.len.min = k.min; els.len.max = k.max; els.len.step = k.step; els.len.value = k.def;
        els.lenLabel.textContent = k.def;
        els.chips.innerHTML = '';
        for (const text of k.chips) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'px-2.5 py-1 rounded-full border border-white/10 bg-white/5 text-[11px] font-semibold text-secondary hover:text-white hover:border-primary/40';
            chip.textContent = text;
            chip.onclick = () => { els.prompt.value = els.prompt.value.trim() ? `${els.prompt.value.trim()}, ${text}` : text; };
            els.chips.appendChild(chip);
        }
    }
    inner.querySelectorAll('.mu-kind').forEach((b) => { b.onclick = () => { kind = b.dataset.kind; applyKind(); }; });
    els.len.oninput = () => { els.lenLabel.textContent = els.len.value; };

    // ── Is the audio model ready? ───────────────────────────────
    async function checkSetup() {
        try {
            const models = await api().listModels();
            const music = models.find((m) => m.id === KINDS.music.model);
            const note = !music ? 'This version of Wan2GP has no Stable Audio 3 model: update Wan2GP.'
                : !music.ready ? (music.unavailableReason || 'Wan2GP is not set up: set its folder in Settings → Local Models.')
                    : music.needsDownload ? 'The audio models download the first time you create something (about 1 GB each).' : '';
            els.setup.textContent = note;
            els.setup.classList.toggle('hidden', !note);
            els.go.disabled = !!music && !music.ready;
        } catch { /* leave the page usable */ }
    }

    // ── Create ──────────────────────────────────────────────────
    function setRunning(on) {
        running = on;
        els.go.classList.toggle('hidden', on);
        els.stop.classList.toggle('hidden', !on);
        els.progress.classList.toggle('hidden', !on);
    }
    async function create() {
        showError('');
        const prompt = els.prompt.value.trim();
        if (!prompt) { showError('Describe what you want to hear first.'); return; }
        const k = KINDS[kind];
        const count = Number(els.count.value) || 1;
        const seedText = els.seed.value.trim();
        const seed = /^[0-9]+$/.test(seedText) ? Number(seedText) : undefined;
        // ✨ Enhance: the rewritten prompt is shown (and can be edited) first; every version uses it.
        const review = await reviewEnhancedPrompt({ text: prompt, kind: kind === 'sfx' ? 'sfx' : 'music', after: promptSwitches || els.prompt });
        if (!review) return;
        stopped = false;
        setRunning(true);
        els.bar.style.width = '0%';
        try {
            for (let i = 0; i < count && !stopped; i++) {
                els.status.textContent = count > 1 ? `Version ${i + 1} of ${count}…` : 'Starting…';
                const result = await api().generate({ model: k.model, prompt: review.prompt, prompt_ready: review.ready || undefined, duration_seconds: Number(els.len.value), ...(seed !== undefined ? { seed: seed + i } : {}) });
                if (!result?.path) throw new Error('The audio model returned no file.');
                history.unshift({ path: result.path, prompt, translated: result.translatedPrompt || '', kind, seconds: Number(els.len.value), seed: result.seed, at: Date.now() });
                saveHistory(history);
                renderHistory();
            }
            els.status.textContent = stopped ? 'Stopped.' : 'Done.';
        } catch (err) {
            if (/cancel/i.test(err.message)) els.status.textContent = 'Stopped.';
            else { showError(err.message); els.status.textContent = ''; }
        } finally {
            setRunning(false);
        }
    }
    els.go.onclick = create;
    els.stop.onclick = () => { stopped = true; api().cancelGeneration(); };
    els.folder.onclick = () => window.localAI.outputs?.open('media').catch((err) => showError(err.message));

    // ── History ─────────────────────────────────────────────────
    async function renderHistory() {
        els.history.innerHTML = '';
        if (!history.length) { els.history.innerHTML = '<p class="text-xs text-secondary">Nothing yet. Describe a sound above and press Create.</p>'; return; }
        const alive = [];
        for (const entry of history) {
            const url = await files().url(entry.path);
            if (!url) continue; // the file was deleted
            alive.push(entry);
            const card = document.createElement('div');
            card.className = 'rounded-xl bg-white/5 border border-white/10 p-3 flex flex-col gap-2';
            card.innerHTML = `
                <div class="flex items-start gap-2">
                    <span class="px-2 py-0.5 rounded-md bg-primary/15 text-primary text-[10px] font-bold uppercase">${entry.kind === 'sfx' ? 'Sound' : 'Music'} · ${fmtTime(entry.seconds || 0)}</span>
                    <span class="text-sm flex-1 min-w-0 break-words">${escapeHtml(entry.prompt)}</span>
                </div>
                <audio class="w-full h-9" controls preload="none"></audio>
                <div class="flex flex-wrap gap-2 text-xs">
                    <button class="mu-reuse px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 font-semibold">Use this description</button>
                    <button class="mu-movie px-3 py-1.5 rounded-lg bg-primary/20 border border-primary/40 text-primary font-bold hover:bg-primary/30">${entry.kind === 'sfx' ? 'Add to Movie' : 'Use in the Movie'}</button>
                    <button class="mu-save px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 font-semibold">Save as…</button>
                    <button class="mu-show px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 font-semibold">Show in folder</button>
                    <button class="mu-del ml-auto px-3 py-1.5 rounded-lg bg-white/5 hover:bg-red-500/60 text-secondary hover:text-white">Delete</button>
                </div>`;
            card.querySelector('audio').src = url;
            card.querySelector('.mu-reuse').onclick = () => { kind = entry.kind || 'music'; applyKind(); els.prompt.value = entry.prompt; els.len.value = entry.seconds || els.len.value; els.lenLabel.textContent = els.len.value; window.scrollTo?.(0, 0); container.scrollTo({ top: 0, behavior: 'smooth' }); };
            card.querySelector('.mu-movie').onclick = () => {
                // The Movie takes music as its soundtrack; a sound effect is added from there, on the scene it belongs to.
                if (entry.kind === 'sfx') { showError('Sound effects are added on a scene in the Movie tab (“Make sound”). The file is in the folder if you want to use it elsewhere.'); return; }
                sendToMovie({ path: entry.path, kind: 'audio' });
            };
            card.querySelector('.mu-save').onclick = async () => {
                try { await window.localAI.outputs.saveCopy(entry.path, `${(entry.prompt || 'sound').slice(0, 40).replace(/[^\w -]+/g, '').trim() || 'sound'}`); } catch (err) { showError(err.message); }
            };
            card.querySelector('.mu-show').onclick = () => files().reveal(entry.path).catch((err) => showError(err.message));
            card.querySelector('.mu-del').onclick = async () => {
                if (!confirm('Delete this sound from the disk?')) return;
                try { await api().deleteOutput(entry.path); } catch (err) { showError(err.message); return; }
                history = history.filter((h) => h !== entry);
                saveHistory(history);
                renderHistory();
            };
            els.history.appendChild(card);
        }
        if (alive.length !== history.length) { history = alive; saveHistory(history); }
    }

    // ── Progress (shared with the other local engines) ─────────────
    unsubscribe = window.localAI.onProgress((e) => {
        if (!running || !e) return;
        if (e.progress != null) els.bar.style.width = `${Math.round(e.progress * 100)}%`;
        if (e.message) els.status.textContent = e.message;
        else if (e.status === 'downloading') els.status.textContent = 'Downloading the audio model (first time only)…';
        else if (e.status === 'loading') els.status.textContent = 'Loading the model…';
    });
    window.addEventListener('beforeunload', () => unsubscribe?.());

    applyKind();
    checkSetup();
    renderHistory();
    return container;
}
