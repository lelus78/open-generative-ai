import { t } from '../lib/i18n.js';
import { takeQueuedReferences, imageUrlToFile } from '../lib/animeHandoff.js';
import { isMovieAvailable, sendToMovie } from '../lib/movieHandoff.js';
import { createPromptSwitches } from '../lib/studioHelpers.js';

// MiniMax H3 reference-to-video through the user's own ComfyUI (desktop app only).
// References (characters / places / objects) + a few sentences → a 4–15 s clip with sound.
// While it samples, a rough colour preview streams in, so a run that goes wrong can be stopped early.

const HISTORY_KEY = 'h3-history-v1';
const HISTORY_MAX = 24;
const MAX_REFS = 4;
const ROLES = [['character', 'Character'], ['place', 'Place'], ['object', 'Object']];
const BASE_MP = [[0.2, 'Draft'], [0.3, 'Standard'], [0.4, 'High'], [0.6, 'Very high']];
const GENRES = ['Action', 'Fantasy', 'Slice of life', 'Sci-fi', 'Comedy', 'Drama', 'Mystery', 'Romance'];
const UPSCALE_MP = [[0.5, '≈ 0.5 MP'], [0.6, '≈ 0.6 MP'], [0.8, '≈ 0.8 MP']];

const api = () => window.localAI?.h3;
const sizeLabel = (mp) => {
    const height = Math.sqrt((mp * 1e6) / (16 / 9));
    const snap = (v) => Math.round(v / 32) * 32;
    return `${snap(height * (16 / 9))}×${snap(height)}`;
};
const option = (value, label, selected) => `<option value="${value}"${selected ? ' selected' : ''}>${label}</option>`;

function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}
function saveHistory(entries) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_MAX))); } catch { /* storage unavailable */ }
}

export function AnimeStudio() {
    const container = document.createElement('div');
    container.className = 'w-full h-full overflow-y-auto custom-scrollbar bg-app-bg text-white';

    // ── State ─────────────────────────────────────────────────
    let status = null;             // from h3.getConfig().status
    let refs = [];                 // { file, url, role, name }
    let running = false;
    let retryAfterStop = false;
    let lastSeed = null;
    let history = loadHistory();
    let unsubscribe = null;
    let timer = null;
    let startedAt = 0;

    const inner = document.createElement('div');
    inner.className = 'max-w-6xl mx-auto px-4 md:px-6 py-8 flex flex-col gap-6';
    container.appendChild(inner);

    inner.innerHTML = `
        <div class="flex flex-col gap-1">
            <h1 class="text-3xl font-bold tracking-tight">${t('nav.anime')}</h1>
            <p class="text-secondary text-sm">MiniMax H3 reference-to-video, running locally through your ComfyUI. Add up to ${MAX_REFS} reference images, describe the scene, and watch a live preview while it renders.</p>
        </div>
        <div class="h3-setup hidden rounded-2xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm flex flex-col gap-3"></div>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div class="flex flex-col gap-5">
                <section class="flex flex-col gap-2">
                    <h2 class="text-xs font-bold uppercase tracking-widest text-secondary">References</h2>
                    <div class="h3-refs grid grid-cols-2 gap-3"></div>
                    <input type="file" accept="image/*" multiple class="h3-file hidden">
                </section>
                <section class="flex flex-col gap-2">
                    <h2 class="text-xs font-bold uppercase tracking-widest text-secondary">What happens</h2>
                    <div class="rounded-xl border border-white/10 bg-white/[0.03] p-3 flex flex-col gap-2">
                        <div class="flex flex-wrap items-center gap-2">
                            <span class="text-xs font-bold text-secondary">Story ideas</span>
                            <div class="h3-genres flex flex-wrap gap-1.5"></div>
                            <button class="h3-suggest ml-auto px-3 py-1.5 rounded-lg bg-primary/20 border border-primary/40 text-primary text-xs font-bold hover:bg-primary/30 disabled:opacity-40">✨ Suggest stories</button>
                        </div>
                        <p class="text-[11px] text-secondary">Pick a genre (or none), then press Suggest. The ideas are written for your references and the chosen length; click one to use it.</p>
                        <div class="h3-ideas flex flex-col gap-2"></div>
                    </div>
                    <textarea class="h3-story w-full min-h-[110px] rounded-xl bg-white/5 border border-white/10 p-3 text-sm outline-none focus:border-primary/60" placeholder="Use the reference names, e.g. “Mika walks into the room, picks up her headphones and puts them on.” Any language: it is translated for the model."></textarea>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                        <input class="h3-style rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-sm outline-none focus:border-primary/60" placeholder="Style (optional) — default: hand-drawn anime">
                        <input class="h3-sound rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-sm outline-none focus:border-primary/60" placeholder="Sound (optional) — default: natural ambience">
                    </div>
                    <details class="text-xs text-secondary">
                        <summary class="cursor-pointer select-none">Advanced: full prompt</summary>
                        <div class="flex flex-col gap-2 mt-2">
                            <textarea class="h3-raw w-full min-h-[160px] rounded-xl bg-white/5 border border-white/10 p-3 font-mono text-[11px] outline-none" placeholder="Leave empty to build the prompt from the fields above. If you write here, this text is used as is."></textarea>
                            <button class="h3-fill self-start px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold">Fill from the fields above</button>
                        </div>
                    </details>
                </section>
                <section class="grid grid-cols-2 gap-3">
                    <label class="flex flex-col gap-1 text-xs text-secondary col-span-2">
                        <span>Length: <b class="h3-seconds-label text-white">8</b> s</span>
                        <input type="range" class="h3-seconds accent-primary" min="4" max="15" step="0.5" value="8">
                    </label>
                    <label class="flex flex-col gap-1 text-xs text-secondary">Quality (first pass)
                        <select class="h3-mp rounded-lg bg-white/5 border border-white/10 px-2 py-2 text-sm text-white">${BASE_MP.map(([v, l]) => option(v, `${l} · ${sizeLabel(v)}`, v === 0.3)).join('')}</select>
                    </label>
                    <label class="flex flex-col gap-1 text-xs text-secondary">Seed (empty = random)
                        <input class="h3-seed rounded-lg bg-white/5 border border-white/10 px-2 py-2 text-sm text-white" inputmode="numeric" placeholder="random">
                    </label>
                    <label class="flex flex-col gap-1 text-xs text-secondary col-span-2">Sound
                        <select class="h3-audio rounded-lg bg-white/5 border border-white/10 px-2 py-2 text-sm text-white">
                            <option value="effects" selected>Effects only, no voices (recommended)</option>
                            <option value="model">Let the model decide (it may invent voices)</option>
                            <option value="off">No sound at all</option>
                        </select>
                    </label>
                    <label class="flex items-center gap-2 text-sm col-span-2">
                        <input type="checkbox" class="h3-upscale accent-primary" checked>
                        <span>Upscale <span class="h3-upscale-hint text-xs text-secondary"></span></span>
                        <select class="h3-upscale-mp ml-auto rounded-lg bg-white/5 border border-white/10 px-2 py-1 text-xs text-white">${UPSCALE_MP.map(([v, l]) => option(v, `${l} · ${sizeLabel(v)}`, v === 0.6)).join('')}</select>
                    </label>
                </section>
                <div class="flex flex-wrap items-center gap-3">
                    <button class="h3-generate px-6 py-3 rounded-xl bg-primary text-black font-bold text-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">Generate</button>
                    <button class="h3-stop hidden px-5 py-3 rounded-xl bg-red-500/90 text-white font-bold text-sm hover:bg-red-500">Stop</button>
                    <button class="h3-retry hidden px-5 py-3 rounded-xl bg-white/10 text-white font-bold text-sm hover:bg-white/15" title="Stop and start again with a new seed">Stop &amp; retry (new seed)</button>
                    <button class="h3-free ml-auto text-xs text-secondary hover:text-white underline" title="Stops ComfyUI so the GPU memory is free again">Free GPU memory</button>
                </div>
                <div class="h3-error hidden rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200 whitespace-pre-wrap break-words"></div>
            </div>
            <div class="flex flex-col gap-3">
                <div class="relative w-full aspect-video rounded-2xl bg-black border border-white/10 overflow-hidden flex items-center justify-center">
                    <img class="h3-preview hidden absolute inset-0 w-full h-full object-contain" alt="">
                    <video class="h3-video hidden absolute inset-0 w-full h-full object-contain" controls loop playsinline></video>
                    <div class="h3-empty text-secondary text-sm text-center px-6">The video appears here.</div>
                    <div class="h3-badge hidden absolute top-2 left-2 px-2 py-1 rounded-md bg-black/70 text-[11px] font-bold uppercase tracking-wider"></div>
                </div>
                <div class="h3-progress hidden flex flex-col gap-1">
                    <div class="flex justify-between text-xs text-secondary"><span class="h3-phase"></span><span class="h3-elapsed"></span></div>
                    <div class="h-2 rounded-full bg-white/10 overflow-hidden"><div class="h3-bar h-full bg-primary transition-all" style="width:0%"></div></div>
                    <p class="text-[11px] text-secondary">The preview is a rough colour sketch of the scene. If the layout or the characters look wrong, press Stop and try again.</p>
                </div>
                <div class="h3-meta hidden text-xs text-secondary"></div>
                <button class="h3-to-movie hidden self-start px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-sm font-semibold">${t('common.sendToMovie')}</button>
            </div>
        </div>
        <section class="flex flex-col gap-2">
            <h2 class="text-xs font-bold uppercase tracking-widest text-secondary">Previous videos</h2>
            <div class="h3-history grid grid-cols-2 md:grid-cols-4 gap-3"></div>
        </section>`;

    const $ = (selector) => inner.querySelector(selector);
    const els = {
        setup: $('.h3-setup'), refs: $('.h3-refs'), file: $('.h3-file'), story: $('.h3-story'), style: $('.h3-style'), sound: $('.h3-sound'),
        raw: $('.h3-raw'), fill: $('.h3-fill'), seconds: $('.h3-seconds'), secondsLabel: $('.h3-seconds-label'), mp: $('.h3-mp'), seed: $('.h3-seed'),
        audio: $('.h3-audio'), upscale: $('.h3-upscale'), upscaleMp: $('.h3-upscale-mp'), upscaleHint: $('.h3-upscale-hint'),
        generate: $('.h3-generate'), stop: $('.h3-stop'), retry: $('.h3-retry'), free: $('.h3-free'), error: $('.h3-error'),
        preview: $('.h3-preview'), video: $('.h3-video'), empty: $('.h3-empty'), badge: $('.h3-badge'),
        genres: $('.h3-genres'), suggest: $('.h3-suggest'), ideas: $('.h3-ideas'),
        toMovie: $('.h3-to-movie'), progress: $('.h3-progress'), phase: $('.h3-phase'), elapsed: $('.h3-elapsed'), bar: $('.h3-bar'), meta: $('.h3-meta'), history: $('.h3-history'),
    };
    // the story keeps the reference names, so it is only translated
    const promptSwitches = createPromptSwitches({ enhance: false });
    if (promptSwitches) els.story.after(promptSwitches);

    // ── Setup banner ────────────────────────────────────────────
    function renderSetup() {
        const ok = status?.ok;
        els.setup.classList.toggle('hidden', !!ok);
        els.setup.classList.toggle('flex', !ok);
        els.setup.innerHTML = '';
        if (!ok) {
            const text = document.createElement('p');
            text.textContent = status?.configured
                ? `ComfyUI is set up at ${status.dir}, but ${status.error || 'something is missing'}.`
                : 'This studio runs MiniMax H3 through ComfyUI. Choose the ComfyUI folder that has the H3 model files.';
            const pick = document.createElement('button');
            pick.className = 'self-start px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 font-semibold';
            pick.textContent = status?.configured ? 'Choose another folder' : 'Choose ComfyUI folder';
            pick.onclick = chooseFolder;
            els.setup.append(text, pick);
        }
        const canUpscale = !!status?.upscaler;
        els.upscale.disabled = !canUpscale;
        if (!canUpscale) els.upscale.checked = false;
        els.upscaleHint.textContent = canUpscale ? '(sharper, takes longer)' : (status?.upscalerHint ? `— not available: ${status.upscalerHint}` : '');
        updateButtons();
    }

    async function chooseFolder() {
        const dir = await api().pickFolder();
        if (!dir) return;
        const cfg = await api().setConfig({ dir, python: '' });
        status = cfg.status;
        renderSetup();
    }

    // ── References ──────────────────────────────────────────
    function renderRefs() {
        els.refs.innerHTML = '';
        refs.forEach((ref, index) => {
            const card = document.createElement('div');
            card.className = 'rounded-xl bg-white/5 border border-white/10 p-2 flex flex-col gap-2';
            card.innerHTML = `
                <div class="relative aspect-video rounded-lg overflow-hidden bg-black/40"><img class="w-full h-full object-cover" alt=""><span class="absolute top-1 left-1 px-1.5 rounded bg-black/70 text-[10px] font-bold">${index + 1}</span><button class="h3-del absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 hover:bg-red-500/80 text-xs" title="Remove">✕</button></div>
                <div class="flex gap-2"><select class="h3-role rounded-lg bg-white/5 border border-white/10 px-1 py-1 text-xs text-white">${ROLES.map(([v, l]) => option(v, l, v === ref.role)).join('')}</select>
                <input class="h3-name min-w-0 flex-1 rounded-lg bg-white/5 border border-white/10 px-2 py-1 text-xs" placeholder="Name, e.g. Mika"></div>
                <input class="h3-notes rounded-lg bg-white/5 border border-white/10 px-2 py-1 text-xs" placeholder="What it looks like (helps story ideas)">
                <label class="flex items-center gap-2 text-[11px] text-secondary" title="Tick it when the picture shows the same character or place from several sides (a contact sheet), so the video does not copy the panels."><input type="checkbox" class="h3-sheet accent-primary"> This picture is a contact sheet</label>`;
            card.querySelector('img').src = ref.url;
            const name = card.querySelector('.h3-name');
            name.value = ref.name;
            name.oninput = () => { ref.name = name.value; };
            const sheetBox = card.querySelector('.h3-sheet');
            sheetBox.checked = !!ref.sheet;
            sheetBox.onchange = () => { ref.sheet = sheetBox.checked; };
            const notes = card.querySelector('.h3-notes');
            notes.value = ref.notes || '';
            notes.oninput = () => { ref.notes = notes.value; };
            card.querySelector('.h3-role').onchange = (e) => { ref.role = e.target.value; };
            card.querySelector('.h3-del').onclick = () => { URL.revokeObjectURL(ref.url); refs.splice(index, 1); renderRefs(); };
            els.refs.appendChild(card);
        });
        if (refs.length < MAX_REFS) {
            const add = document.createElement('button');
            add.className = 'aspect-video rounded-xl border-2 border-dashed border-white/15 hover:border-primary/60 text-secondary text-sm flex items-center justify-center';
            add.textContent = '+ Add reference image';
            add.onclick = () => els.file.click();
            add.ondragover = (e) => { e.preventDefault(); };
            add.ondrop = (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); };
            els.refs.appendChild(add);
        }
        updateButtons();
    }
    function addFiles(fileList, extra = {}) {
        for (const file of Array.from(fileList || [])) {
            if (refs.length >= MAX_REFS || !file.type.startsWith('image/')) continue;
            // The first image is usually the character, the rest scenery.
            refs.push({ file, url: URL.createObjectURL(file), role: extra.role || (refs.length === 0 ? 'character' : 'place'), name: '', notes: extra.prompt || '', sheet: !!extra.sheet });
        }
        renderRefs();
    }
    els.file.onchange = () => { addFiles(els.file.files); els.file.value = ''; };

    // ── Controls ────────────────────────────────────────────────
    els.seconds.oninput = () => { els.secondsLabel.textContent = els.seconds.value; };
    function updateButtons() {
        els.generate.disabled = running || !status?.ok || refs.length === 0;
        els.generate.classList.toggle('hidden', running);
        els.stop.classList.toggle('hidden', !running);
        els.retry.classList.toggle('hidden', !running);
    }
    const spec = () => ({
        refs: refs.map((r, i) => ({ role: r.role, name: r.name, sheet: r.sheet, tag: refLabel(r, i) })),
        story: els.story.value, style: els.style.value, sound: els.sound.value, voices: els.audio.value === 'model',
    });
    els.fill.onclick = async () => {
        try { els.raw.value = await api().composePrompt(spec()); showError(''); } catch (err) { showError(err.message); }
    };
    els.free.onclick = async () => {
        try { await api().freeGpu(); } catch (err) { showError(err.message); }
    };
    function showError(message) {
        els.error.textContent = message || '';
        els.error.classList.toggle('hidden', !message);
    }

    // ── Story ideas ───────────────────────────────────────────────
    let genre = '';
    const refLabel = (ref, index) => (ref.name || '').trim() || `${ROLES.find(([v]) => v === ref.role)?.[1] || 'Reference'} ${index + 1}`;
    function renderGenres() {
        els.genres.innerHTML = '';
        for (const name of GENRES) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.textContent = name;
            chip.className = `px-2.5 py-1 rounded-full border text-[11px] font-semibold ${genre === name ? 'bg-primary/20 border-primary/40 text-primary' : 'bg-white/5 border-white/10 text-secondary hover:text-white'}`;
            chip.onclick = () => { genre = genre === name ? '' : name; renderGenres(); };
            els.genres.appendChild(chip);
        }
    }
    async function suggestStories() {
        showError('');
        if (!refs.length) { showError('Add at least one reference image first.'); return; }
        if (!window.localAI?.suggestStories) { showError('Story ideas are available in the desktop app only.'); return; }
        els.suggest.disabled = true;
        els.suggest.textContent = 'Writing…';
        els.ideas.innerHTML = '';
        try {
            const stories = await window.localAI.suggestStories({
                refs: refs.map((r, i) => ({ role: r.role, name: refLabel(r, i), notes: r.notes })),
                seconds: Number(els.seconds.value), genre, count: 4,
            });
            for (const [n, idea] of stories.entries()) {
                const card = document.createElement('button');
                card.type = 'button';
                card.className = 'text-left rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 hover:border-primary/50 p-3 flex flex-col gap-1';
                const title = document.createElement('span');
                title.className = 'text-xs font-bold text-primary';
                title.textContent = idea.title || `Idea ${n + 1}`;
                const body = document.createElement('span');
                body.className = 'text-sm text-white/90';
                body.textContent = idea.story;
                card.append(title, body);
                card.onclick = () => { els.story.value = idea.story; els.raw.value = ''; els.story.scrollIntoView({ block: 'nearest' }); };
                els.ideas.appendChild(card);
            }
        } catch (err) {
            showError(err.message);
        } finally {
            els.suggest.disabled = false;
            els.suggest.textContent = '✨ Suggest stories';
        }
    }
    els.suggest.onclick = suggestStories;

    // ── Live events ─────────────────────────────────────────────
    const PHASE_TEXT = { base: 'Pass 1 — building the video', refine: 'Pass 2 — refining the upscaled video' };
    function tick() { els.elapsed.textContent = `${Math.round((Date.now() - startedAt) / 1000)} s`; }
    function setBadge(text) { els.badge.textContent = text; els.badge.classList.toggle('hidden', !text); }
    function onEvent(event) {
        if (!running) return;
        if (event.type === 'status') {
            if (event.seed) lastSeed = event.seed;
            if (event.message) els.phase.textContent = event.message;
        } else if (event.type === 'progress') {
            const passes = els.upscale.checked ? 2 : 1;
            const pass = event.phase === 'refine' ? 1 : 0;
            els.phase.textContent = `${PHASE_TEXT[event.phase] || ''} · step ${event.value}/${event.max}`;
            els.bar.style.width = `${Math.round(((pass + event.value / event.max) / passes) * 100)}%`;
        } else if (event.type === 'preview') {
            els.preview.src = event.dataUrl;
            els.preview.classList.remove('hidden');
            els.empty.classList.add('hidden');
            setBadge(event.phase === 'refine' ? 'Preview · pass 2' : 'Preview · pass 1');
        }
    }

    // ── Generate / stop ─────────────────────────────────────────
    async function generate() {
        showError('');
        const seedText = els.seed.value.trim();
        const seed = /^\d+$/.test(seedText) ? Number(seedText) : undefined;
        running = true;
        updateButtons();
        els.video.pause();
        els.video.classList.add('hidden');
        els.preview.classList.add('hidden');
        els.empty.textContent = 'Starting…';
        els.empty.classList.remove('hidden');
        els.progress.classList.remove('hidden');
        els.bar.style.width = '0%';
        els.phase.textContent = 'Starting…';
        els.meta.classList.add('hidden');
        startedAt = Date.now();
        clearInterval(timer);
        timer = setInterval(tick, 1000);
        try {
            const images = await Promise.all(refs.map(async (r) => ({ name: r.file.name, bytes: new Uint8Array(await r.file.arrayBuffer()) })));
            const result = await api().generate({
                images, spec: spec(), rawPrompt: els.raw.value.trim() || undefined, seed,
                seconds: Number(els.seconds.value), megapixels: Number(els.mp.value),
                upscale: els.upscale.checked, upscaleMegapixels: Number(els.upscaleMp.value),
                audio: els.audio.value === 'off' ? 'off' : 'on',
            });
            showResult(result, { seconds: Number(els.seconds.value), story: els.story.value });
            history.unshift({ path: result.path, seed: result.seed, story: els.story.value, seconds: Number(els.seconds.value), at: Date.now() });
            saveHistory(history);
            renderHistory();
        } catch (err) {
            const stopped = /cancelled/i.test(err.message);
            const hasPreview = !els.preview.classList.contains('hidden');
            if (stopped) els.preview.classList.add('hidden');
            els.empty.textContent = stopped ? 'Stopped.' : 'Failed.';
            els.empty.classList.toggle('hidden', !stopped && hasPreview);
            if (!stopped) showError(err.message);
        } finally {
            running = false;
            clearInterval(timer);
            els.progress.classList.add('hidden');
            setBadge('');
            updateButtons();
        }
        if (retryAfterStop) {
            retryAfterStop = false;
            els.seed.value = '';
            generate();
        }
    }
    function showResult(result, info) {
        els.preview.classList.add('hidden');
        els.empty.classList.add('hidden');
        els.video.src = result.url;
        els.video.classList.remove('hidden');
        els.video.play().catch(() => {});
        els.meta.textContent = `Seed ${result.seed} · ${info.seconds} s · ${Math.round((Date.now() - startedAt) / 1000)} s to render`;
        els.meta.classList.remove('hidden');
        els.toMovie.classList.toggle('hidden', !(isMovieAvailable() && result.path));
        els.toMovie.onclick = () => sendToMovie({ path: result.path, kind: 'video' });
    }
    els.generate.onclick = generate;
    els.stop.onclick = () => api().cancel();
    els.retry.onclick = () => { retryAfterStop = true; api().cancel(); };

    // ── History ─────────────────────────────────────────────────
    async function renderHistory() {
        els.history.innerHTML = '';
        for (const entry of history) {
            const url = await api().readOutput(entry.path);
            if (!url) continue; // file was deleted
            const card = document.createElement('div');
            card.className = 'group relative rounded-xl overflow-hidden bg-black border border-white/10 cursor-pointer';
            card.innerHTML = '<video class="w-full aspect-video object-cover" muted preload="metadata"></video><button class="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 hover:bg-red-500/80 text-xs opacity-0 group-hover:opacity-100" title="Delete">✕</button><div class="px-2 py-1 text-[11px] text-secondary truncate"></div>';
            card.querySelector('video').src = url;
            card.lastChild.textContent = entry.story || `Seed ${entry.seed}`;
            card.onclick = () => { startedAt = Date.now(); showResult({ url, seed: entry.seed, path: entry.path }, { seconds: entry.seconds }); els.meta.textContent = `Seed ${entry.seed} · ${entry.seconds} s`; };
            card.querySelector('button').onclick = async (e) => {
                e.stopPropagation();
                try { await api().deleteOutput(entry.path); } catch (err) { showError(err.message); return; }
                history = history.filter((h) => h !== entry);
                saveHistory(history);
                renderHistory();
            };
            els.history.appendChild(card);
        }
    }

    // ── Boot ────────────────────────────────────────────────────
    if (!api()) {
        inner.innerHTML = '<p class="text-secondary">MiniMax H3 runs in the desktop app only.</p>';
        return container;
    }
    unsubscribe = api().onEvent(onEvent);
    api().getConfig().then((cfg) => { status = cfg.status; renderSetup(); });
    renderRefs();
    renderHistory();
    renderGenres();
    // Pictures sent from the Image / Cinema studio.
    async function takeSentReferences() {
        for (const item of takeQueuedReferences()) {
            if (refs.length >= MAX_REFS) { showError(`At most ${MAX_REFS} reference images fit — remove one first.`); break; }
            try { addFiles([await imageUrlToFile(item.url, `reference-${Date.now()}.png`)], { prompt: item.prompt, role: item.role, sheet: item.sheet }); } catch (err) { showError(err.message); }
        }
    }
    window.addEventListener('anime:references', takeSentReferences);
    takeSentReferences();
    window.addEventListener('beforeunload', () => unsubscribe?.());
    return container;
}
