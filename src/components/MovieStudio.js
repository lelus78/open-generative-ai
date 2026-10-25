import { t } from '../lib/i18n.js';
import { takeQueuedMovieItems } from '../lib/movieHandoff.js';
import { localAI } from '../lib/localInferenceClient.js';
import { mergeContinuityRef, withContinuityStory } from '../lib/movieContinuity.js';
import { foldTransparentTitles } from '../lib/movieTimeline.js';

// Movie studio: turns the pictures and clips made by the local studios into one finished movie.
// Timeline of scenes → optional "animate this picture" (Wan2GP image-to-video) → ffmpeg render
// with transitions, captions and background music. Everything runs on this machine.

const PROJECT_KEY = 'movie-project-v1';
const FORMATS = [
    ['1280x720', 'Landscape 16:9 · 1280×720'], ['1920x1080', 'Landscape 16:9 · 1920×1080'],
    ['720x1280', 'Vertical 9:16 · 720×1280 (Reels, Shorts)'], ['1080x1920', 'Vertical 9:16 · 1080×1920'],
    ['1024x1024', 'Square 1:1 · 1024×1024'], ['1080x1350', 'Portrait 4:5 · 1080×1350 (Instagram)'],
];
// Filled from the backend (movie:options); these are the fallbacks.
let TRANSITIONS = [['fade', 'Cross-fade'], ['none', 'Straight cut'], ['fadeblack', 'Dip to black'], ['slideleft', 'Slide'], ['wipeleft', 'Wipe'], ['circleopen', 'Circle']];
let TITLE_STYLES = [['classic', 'Classic']];
let CAPTION_STYLES = [['subtitle', 'Subtitle']];
const MOTIONS = [['zoom-in', 'Slow zoom in'], ['zoom-out', 'Slow zoom out'], ['pan-left', 'Pan left'], ['pan-right', 'Pan right'], ['none', 'Still']];
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

const api = () => window.localAI?.movie;
const option = (value, label, selected) => `<option value="${value}"${selected ? ' selected' : ''}>${label}</option>`;
const basename = (p) => String(p || '').split(/[\\/]/).pop();
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const aspectOf = (format) => { const [w, h] = format.split('x').map(Number); return h > w ? 'portrait' : w === h ? 'square' : 'landscape'; };
const aspectRatioParam = (format) => ({ portrait: '9:16', square: '1:1', landscape: '16:9' }[aspectOf(format)]);

function loadProject() {
    try { return JSON.parse(localStorage.getItem(PROJECT_KEY) || 'null'); } catch { return null; }
}

export function MovieStudio() {
    const container = document.createElement('div');
    container.className = 'w-full h-full overflow-y-auto custom-scrollbar bg-app-bg text-white';
    const inner = document.createElement('div');
    inner.className = 'max-w-6xl mx-auto px-4 md:px-6 py-8 flex flex-col gap-6';
    container.appendChild(inner);

    if (!api()) {
        inner.innerHTML = '<p class="text-secondary">The movie maker runs in the desktop app only.</p>';
        return container;
    }

    // ── State ─────────────────────────────────────────────────
    const saved = loadProject() || {};
    const state = {
        scenes: Array.isArray(saved.scenes) ? saved.scenes : [], // { id, path, kind, duration, motion, caption, trimEnd, prompt, thumb }
        format: saved.format || '1280x720', fps: saved.fps || 24,
        transition: saved.transition || 'fade', transitionSeconds: saved.transitionSeconds ?? 0.7,
        keepAudio: saved.keepAudio !== false, fadeInOut: saved.fadeInOut !== false,
        music: saved.music || null, musicVolume: saved.musicVolume ?? 0.4,
        animateModel: saved.animateModel || '', animateSeconds: saved.animateSeconds || 5,
    };
    let status = null;
    let rendering = false;
    let animatingId = null;
    let lastMovie = null;
    let unsubscribe = null;
    let unsubscribeProgress = null;
    const durationOf = new Map(); // path → probed seconds

    function persist() {
        try {
            localStorage.setItem(PROJECT_KEY, JSON.stringify({ ...state, scenes: state.scenes.map(({ thumb, ...rest }) => rest) }));
        } catch { /* storage unavailable */ }
    }

    inner.innerHTML = `
        <div class="flex flex-col gap-1">
            <h1 class="text-3xl font-bold tracking-tight">${t('nav.movie')}</h1>
            <p class="text-secondary text-sm">Build a complete movie from the pictures and clips you made locally: arrange the scenes, bring pictures to life, add transitions, captions and music, then export one video file.</p>
        </div>
        <div class="mv-setup hidden rounded-2xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm"></div>
        <section class="mv-director rounded-2xl border border-primary/30 bg-primary/5 p-4 flex flex-col gap-3">
            <div class="flex flex-wrap items-center gap-2">
                <h2 class="text-xs font-bold uppercase tracking-widest text-primary">AI director</h2>
                <span class="text-[11px] text-secondary">Describe the movie in any language. The local AI writes the shots, then makes the pictures, camera motion, titles, sounds and music, and builds the movie.</span>
            </div>
            <textarea class="mv-idea w-full min-h-[70px] rounded-xl bg-white/5 border border-white/10 p-3 text-sm outline-none focus:border-primary/60" placeholder="e.g. Trailer of a medieval fantasy video game: a lone knight crosses a plain, a besieged castle, an archer, an epic final clash."></textarea>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                <label class="flex flex-col gap-1 text-xs text-secondary">Number of shots
                    <input type="number" class="mv-shots-n rounded-lg bg-white/5 border border-white/10 px-2 py-2 text-sm text-white" min="2" max="12" value="6"></label>
                <label class="flex flex-col gap-1 text-xs text-secondary md:col-span-2">Visual style
                    <input class="mv-style rounded-lg bg-white/5 border border-white/10 px-2 py-2 text-sm text-white" value="epic cinematic video game trailer, dramatic light, highly detailed"></label>
                <label class="flex flex-col gap-1 text-xs text-secondary">Picture model
                    <select class="mv-pic-model rounded-lg bg-white/5 border border-white/10 px-2 py-2 text-sm text-white"></select></label>
            </div>
            <div class="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
                <label class="flex items-center gap-2"><input type="checkbox" class="mv-opt-titles accent-primary" checked> Opening and closing title cards</label>
                <label class="flex items-center gap-2"><input type="checkbox" class="mv-opt-sfx accent-primary" checked> Sound effects</label>
                <label class="flex items-center gap-2"><input type="checkbox" class="mv-opt-music accent-primary" checked> Music</label>
                <label class="flex items-center gap-2" title="The last frame of the previous shot becomes a reference of the next one. Useful for ONE continuous action, but the new shot tends to drift back to that picture, so it is off by default and not good for cuts to a new action (MiniMax H3 only)"><input type="checkbox" class="mv-opt-continuity accent-primary"> Continue each shot from the previous one (experimental)</label>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
                <label class="flex flex-col gap-1 text-xs text-secondary md:col-span-2">How the shots are made
                    <select class="mv-engine rounded-lg bg-white/5 border border-white/10 px-2 py-2 text-sm text-white">
                        <option value="h3">Real video from references — MiniMax H3 (characters and places from your pictures move for real, with sound)</option>
                        <option value="animate">Picture of each shot, then animated with Wan2GP image-to-video (slow)</option>
                        <option value="still">Pictures with camera moves only (fast, a slideshow)</option>
                    </select></label>
                <label class="flex flex-col gap-1 text-xs text-secondary">Length of each shot: <b class="mv-shot-sec-label text-white">6</b> s
                    <input type="range" class="mv-shot-sec accent-primary" min="4" max="12" step="1" value="6"></label>
                <label class="flex flex-col gap-1 text-xs text-secondary md:col-span-3">Quality of each shot (H3)
                    <select class="mv-shot-quality rounded-lg bg-white/5 border border-white/10 px-2 py-2 text-sm text-white">
                        <option value="standard">Standard — fastest (about 736×416)</option>
                        <option value="sharp">Sharper — H3 makes a second, detailed pass at double size (about +1 min per shot, ~1024×576)</option>
                        <option value="best">Best — bigger first pass and a detailed second pass (about +2 min per shot, ~1280×720)</option>
                    </select></label>
            </div>
            <div class="mv-refs-box flex flex-col gap-2">
                <div class="flex items-center gap-2"><span class="text-xs font-bold text-secondary">Reference pictures (characters, places, objects — up to 4)</span>
                    <button class="mv-add-ref px-3 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold">+ From Image Studio</button></div>
                <div class="mv-refs grid grid-cols-2 md:grid-cols-4 gap-2"></div>
            </div>
            <div class="flex flex-wrap items-center gap-3">
                <button class="mv-write px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-sm font-semibold disabled:opacity-40">✍ Write the storyboard</button>
                <button class="mv-produce px-4 py-2 rounded-xl bg-primary text-black text-sm font-bold hover:opacity-90 disabled:opacity-40">🎬 Produce the whole movie</button>
                <button class="mv-dir-stop hidden px-4 py-2 rounded-xl bg-red-500/90 text-white text-sm font-bold">Stop</button>
                <span class="mv-dir-status text-xs text-secondary"></span>
            </div>
            <div class="mv-shots flex flex-col gap-2"></div>
        </section>
        <section class="flex flex-col gap-3">
            <div class="flex flex-wrap items-center gap-2">
                <h2 class="text-xs font-bold uppercase tracking-widest text-secondary mr-2">Scenes</h2>
                <button class="mv-add-title px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold">+ Title card</button>
                <button class="mv-add-library px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold">+ Clips made in the app</button>
                <button class="mv-add-images px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold">+ Pictures from files</button>
                <button class="mv-add-history px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold">+ Pictures from Image Studio</button>
                <button class="mv-add-videos px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold">+ Videos from files</button>
                <button class="mv-clear ml-auto text-xs text-secondary hover:text-white underline">Clear all</button>
            </div>
            <div class="mv-picker hidden rounded-2xl border border-white/10 bg-white/[0.03] p-3"></div>
            <div class="mv-scenes flex flex-col gap-3"></div>
            <p class="mv-total text-xs text-secondary"></p>
        </section>
        <section class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div class="flex flex-col gap-4">
                <h2 class="text-xs font-bold uppercase tracking-widest text-secondary">Look &amp; sound</h2>
                <div class="grid grid-cols-2 gap-3">
                    <label class="flex flex-col gap-1 text-xs text-secondary col-span-2">Format
                        <select class="mv-format rounded-lg bg-white/5 border border-white/10 px-2 py-2 text-sm text-white">${FORMATS.map(([v, l]) => option(v, l, v === state.format)).join('')}</select></label>
                    <label class="flex flex-col gap-1 text-xs text-secondary">Between scenes
                        <select class="mv-transition rounded-lg bg-white/5 border border-white/10 px-2 py-2 text-sm text-white">${TRANSITIONS.map(([v, l]) => option(v, l, v === state.transition)).join('')}</select></label>
                    <label class="flex flex-col gap-1 text-xs text-secondary">Transition length: <b class="mv-tsec-label text-white">${state.transitionSeconds}</b> s
                        <input type="range" class="mv-tsec accent-primary" min="0.3" max="2" step="0.1" value="${state.transitionSeconds}"></label>
                    <label class="flex flex-col gap-1 text-xs text-secondary">Frame rate
                        <select class="mv-fps rounded-lg bg-white/5 border border-white/10 px-2 py-2 text-sm text-white">${[24, 25, 30].map((v) => option(v, `${v} fps`, v === state.fps)).join('')}</select></label>
                    <div class="flex flex-col gap-2 justify-end text-sm">
                        <label class="flex items-center gap-2"><input type="checkbox" class="mv-keep accent-primary" ${state.keepAudio ? 'checked' : ''}> Keep the sound of the clips</label>
                        <label class="flex items-center gap-2"><input type="checkbox" class="mv-fade accent-primary" ${state.fadeInOut ? 'checked' : ''}> Fade in and out</label>
                    </div>
                </div>
                <div class="rounded-xl border border-white/10 bg-white/[0.03] p-3 flex flex-col gap-2">
                    <div class="flex items-center gap-2">
                        <span class="text-xs font-bold text-secondary">Background music</span>
                        <span class="mv-music-name text-xs truncate flex-1"></span>
                        <button class="mv-music-pick px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold">Choose file…</button>
                        <button class="mv-music-clear hidden text-xs text-secondary hover:text-white underline">Remove</button>
                    </div>
                    <label class="flex flex-col gap-1 text-xs text-secondary">Music volume: <b class="mv-mvol-label text-white">${Math.round(state.musicVolume * 100)}</b> %
                        <input type="range" class="mv-mvol accent-primary" min="0" max="1" step="0.05" value="${state.musicVolume}"></label>
                    <div class="flex gap-2">
                        <input class="mv-music-prompt min-w-0 flex-1 rounded-lg bg-white/5 border border-white/10 px-2 py-1.5 text-xs text-white" placeholder="Or make it with AI: e.g. epic orchestral, taiko drums, 90 BPM, heroic">
                        <button class="mv-music-make px-3 py-1.5 rounded-lg bg-primary/20 border border-primary/40 text-primary text-xs font-bold hover:bg-primary/30 disabled:opacity-40">🎵 Compose</button>
                    </div>
                    <audio class="mv-music-audio hidden h-8 w-full" controls preload="none"></audio>
                    <p class="text-[11px] text-secondary">The music is looped or cut to the movie length and fades out at the end.</p>
                </div>
                <div class="rounded-xl border border-white/10 bg-white/[0.03] p-3 flex flex-col gap-2">
                    <span class="text-xs font-bold text-secondary">Bring pictures to life (local AI, Wan2GP)</span>
                    <div class="grid grid-cols-2 gap-2">
                        <label class="flex flex-col gap-1 text-xs text-secondary col-span-2">Image-to-video model
                            <select class="mv-animate-model rounded-lg bg-white/5 border border-white/10 px-2 py-2 text-sm text-white"></select></label>
                        <label class="flex flex-col gap-1 text-xs text-secondary col-span-2">Clip length: <b class="mv-asec-label text-white">${state.animateSeconds}</b> s
                            <input type="range" class="mv-asec accent-primary" min="2" max="8" step="1" value="${state.animateSeconds}"></label>
                    </div>
                    <p class="text-[11px] text-secondary">Use “Animate” on a picture scene: describe the movement, wait for the clip, and the scene becomes a real video. Pictures you do not animate get a slow camera move instead.</p>
                </div>
            </div>
            <div class="flex flex-col gap-3">
                <h2 class="text-xs font-bold uppercase tracking-widest text-secondary">Your movie</h2>
                <div class="relative w-full aspect-video rounded-2xl bg-black border border-white/10 overflow-hidden flex items-center justify-center">
                    <video class="mv-video hidden absolute inset-0 w-full h-full object-contain" controls playsinline></video>
                    <div class="mv-empty text-secondary text-sm text-center px-6">The finished movie appears here.</div>
                </div>
                <div class="mv-progress hidden flex flex-col gap-1">
                    <div class="flex justify-between text-xs text-secondary"><span class="mv-phase">Rendering…</span><span class="mv-percent"></span></div>
                    <div class="h-2 rounded-full bg-white/10 overflow-hidden"><div class="mv-bar h-full bg-primary transition-all" style="width:0%"></div></div>
                </div>
                <div class="flex flex-wrap items-center gap-3">
                    <button class="mv-render px-6 py-3 rounded-xl bg-primary text-black font-bold text-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">Make the movie</button>
                    <button class="mv-preview px-4 py-3 rounded-xl bg-white/10 hover:bg-white/15 text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed" title="Half size, ready in a few seconds: check the cut before the final render">⚡ Quick preview</button>
                    <button class="mv-cancel hidden px-5 py-3 rounded-xl bg-red-500/90 text-white font-bold text-sm hover:bg-red-500">Stop</button>
                    <button class="mv-save hidden px-4 py-3 rounded-xl bg-white/10 hover:bg-white/15 text-sm font-semibold">Save as…</button>
                    <button class="mv-reveal hidden px-4 py-3 rounded-xl bg-white/10 hover:bg-white/15 text-sm font-semibold">Show in folder</button>
                </div>
                <div class="mv-upscale hidden rounded-xl border border-white/10 bg-white/[0.03] p-3 flex flex-col gap-2">
                    <span class="text-xs font-bold text-secondary">Final upscale</span>
                    <div class="grid grid-cols-2 gap-2">
                        <label class="flex flex-col gap-1 text-xs text-secondary">Size
                            <select class="mv-up-target rounded-lg bg-white/5 border border-white/10 px-2 py-2 text-sm text-white">
                                <option value="1080p">Full HD · 1080p</option><option value="1440p">2K · 1440p</option><option value="4k">4K · 2160p</option></select></label>
                        <label class="flex flex-col gap-1 text-xs text-secondary">Method
                            <select class="mv-up-method rounded-lg bg-white/5 border border-white/10 px-2 py-2 text-sm text-white">
                                <option value="fast">Fast (Lanczos + sharpen) — keeps faces natural</option><option value="ai">AI upscale with ComfyUI (slower, can smooth faces)</option></select></label>
                        <label class="mv-up-model-wrap flex flex-col gap-1 text-xs text-secondary col-span-2">AI model
                            <select class="mv-up-model rounded-lg bg-white/5 border border-white/10 px-2 py-2 text-sm text-white"></select></label>
                        <label class="mv-up-strength-wrap flex flex-col gap-1 text-xs text-secondary col-span-2">AI strength: <b class="mv-up-strength-label text-white">40</b> %
                            <input type="range" class="mv-up-strength accent-primary" min="0" max="100" step="5" value="40">
                            <span class="text-[11px]">How much of the AI picture is used; the rest is the plain enlargement. Lower keeps faces and skin natural, higher is sharper but smoother.</span></label>
                    </div>
                    <div class="flex items-center gap-3">
                        <button class="mv-up-go px-4 py-2 rounded-xl bg-primary/20 border border-primary/40 text-primary text-sm font-bold hover:bg-primary/30 disabled:opacity-40">⬆ Upscale the movie</button>
                        <span class="text-[11px] text-secondary">The AI method cuts the movie in 2-second pieces, upscales each one on the GPU and joins them again with the original sound.</span>
                    </div>
                </div>
                <div class="mv-error hidden rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200 whitespace-pre-wrap break-words"></div>
                <div class="mv-meta hidden text-xs text-secondary"></div>
            </div>
        </section>`;

    const $ = (selector) => inner.querySelector(selector);
    const els = {
        setup: $('.mv-setup'), picker: $('.mv-picker'), scenes: $('.mv-scenes'), total: $('.mv-total'),
        format: $('.mv-format'), transition: $('.mv-transition'), tsec: $('.mv-tsec'), tsecLabel: $('.mv-tsec-label'), fps: $('.mv-fps'),
        keep: $('.mv-keep'), fade: $('.mv-fade'), musicName: $('.mv-music-name'), musicPick: $('.mv-music-pick'), musicClear: $('.mv-music-clear'),
        musicPrompt: $('.mv-music-prompt'), musicMake: $('.mv-music-make'), musicAudio: $('.mv-music-audio'), mvol: $('.mv-mvol'), mvolLabel: $('.mv-mvol-label'), animateModel: $('.mv-animate-model'), asec: $('.mv-asec'), asecLabel: $('.mv-asec-label'),
        video: $('.mv-video'), empty: $('.mv-empty'), progress: $('.mv-progress'), phase: $('.mv-phase'), percent: $('.mv-percent'), bar: $('.mv-bar'),
        upPanel: $('.mv-upscale'), upTarget: $('.mv-up-target'), upMethod: $('.mv-up-method'), upModel: $('.mv-up-model'), upModelWrap: $('.mv-up-model-wrap'), upStrengthWrap: $('.mv-up-strength-wrap'), upStrength: $('.mv-up-strength'), upStrengthLabel: $('.mv-up-strength-label'), upGo: $('.mv-up-go'),
        render: $('.mv-render'), preview: $('.mv-preview'), cancel: $('.mv-cancel'), save: $('.mv-save'), reveal: $('.mv-reveal'), error: $('.mv-error'), meta: $('.mv-meta'),
    };
    const showError = (message) => {
        els.error.textContent = message || '';
        els.error.classList.toggle('hidden', !message);
        // A video is still being made in the background (for example the page was reloaded while it ran): say so, and offer to stop it.
        if (/H3 generation is already running/i.test(message || '') && window.localAI?.h3) {
            els.error.textContent = 'A video is still being made in the background (it was started before this page was reloaded, so its result can no longer be attached here). Wait for it to finish — it will then appear under “+ Clips made in the app” — or stop it now.';
            const stop = document.createElement('button');
            stop.className = 'mt-2 block px-3 py-1.5 rounded-lg bg-red-500/80 hover:bg-red-500 text-white text-xs font-bold';
            stop.textContent = 'Stop the running video';
            stop.onclick = async () => { stop.disabled = true; try { await window.localAI.h3.cancel(); } catch { /* idle */ } showError(''); };
            els.error.appendChild(stop);
        }
    };

    // ── Scenes ──────────────────────────────────────────────────
    const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    async function addScene({ path, kind, prompt, label }) {
        const isImage = kind ? kind === 'image' : IMAGE_RE.test(path);
        const scene = { id: newId(), path, kind: isImage ? 'image' : 'video', duration: isImage ? 4 : 0, motion: 'zoom-in', caption: '', prompt: prompt || '', trimEnd: 0, label: label || '' };
        scene.thumb = await api().url(path);
        if (!isImage) {
            const [info] = await api().probe([path]);
            if (info?.error) { showError(info.error); return; }
            scene.duration = info.duration || 0;
            durationOf.set(path, scene.duration);
        }
        state.scenes.push(scene);
    }
    async function addMany(items) {
        showError('');
        for (const item of items) {
            try { await addScene(typeof item === 'string' ? { path: item } : item); } catch (err) { showError(err.message); }
        }
        persist();
        renderScenes();
    }
    const sceneSeconds = (s) => (s.kind === 'image' || s.kind === 'title' ? s.duration : (s.trimEnd > 0 ? Math.min(s.trimEnd, s.duration) : s.duration));
    function totalSeconds() {
        const lengths = foldTransparentTitles(state.scenes).map(sceneSeconds);
        if (!lengths.length) return 0;
        const t = state.transition === 'none' ? 0 : Math.min(state.transitionSeconds, Math.min(...lengths) / 2 - 0.05);
        return Math.max(0, lengths.reduce((a, b) => a + b, 0) - Math.max(0, t) * (lengths.length - 1));
    }
    function renderTotal() {
        const total = totalSeconds();
        els.total.textContent = state.scenes.length ? `${state.scenes.length} scene${state.scenes.length === 1 ? '' : 's'} · about ${fmtTime(total)}` : 'No scenes yet. Add clips or pictures above.';
        els.render.disabled = rendering || !status?.ok || !state.scenes.length || !!animatingId;
        els.preview.disabled = els.render.disabled;
    }
    const escapeHtml = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const moveScene = (index, delta) => {
        const target = index + delta;
        if (target < 0 || target >= state.scenes.length) return;
        [state.scenes[target], state.scenes[index]] = [state.scenes[index], state.scenes[target]];
        persist();
        renderScenes();
    };
    function renderScenes() {
        els.scenes.innerHTML = '';
        state.scenes.forEach((scene, index) => {
            const card = document.createElement('div');
            card.className = 'rounded-xl bg-white/5 border border-white/10 p-3 flex gap-3';
            const isImage = scene.kind === 'image';
            const isTitle = scene.kind === 'title';
            const mediaHtml = isTitle
                ? `<div class="w-full h-full flex flex-col items-center justify-center text-center px-2" style="background:${escapeHtml(scene.color || '#0b0f1a')}"><b class="text-[11px] leading-tight">${escapeHtml(scene.title || 'Title')}</b><span class="text-[8px] text-white/70">${escapeHtml(scene.subtitle || '')}</span></div>`
                : isImage ? '<img class="w-full h-full object-cover" alt="">' : '<video class="w-full h-full object-contain bg-black" controls preload="metadata"></video>';
            card.innerHTML = `
                <div class="relative w-56 shrink-0 aspect-video rounded-lg overflow-hidden bg-black/50">
                    ${mediaHtml}
                    <span class="absolute top-1 left-1 px-1.5 rounded bg-black/70 text-[10px] font-bold">${index + 1}</span>
                    <span class="absolute bottom-1 left-1 px-1.5 rounded bg-black/70 text-[10px]">${isTitle ? 'Title card' : isImage ? 'Picture' : 'Video'}</span>
                </div>
                <div class="flex-1 min-w-0 flex flex-col gap-2">
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-secondary truncate flex-1" title="${escapeHtml(scene.path)}">${escapeHtml(scene.label || (isTitle ? 'Title card' : basename(scene.path)))}</span>
                        <button class="mv-up w-6 h-6 rounded bg-white/10 hover:bg-white/20 text-xs" title="Move earlier">↑</button>
                        <button class="mv-down w-6 h-6 rounded bg-white/10 hover:bg-white/20 text-xs" title="Move later">↓</button>
                        <button class="mv-del w-6 h-6 rounded bg-white/10 hover:bg-red-500/80 text-xs" title="Remove">✕</button>
                    </div>
                    <div class="mv-texts flex flex-col gap-2"></div>
                    <div class="mv-style-row flex flex-wrap items-center gap-2 text-xs text-secondary"></div>
                    <div class="mv-extra flex flex-wrap items-center gap-3 text-xs text-secondary"></div>
                    <div class="mv-sfx flex flex-wrap items-center gap-2 text-xs text-secondary"></div>
                    <div class="mv-redo flex flex-col gap-2"></div>
                </div>`;
            if (!isTitle) {
                const media = card.querySelector(isImage ? 'img' : 'video');
                if (scene.thumb) media.src = scene.thumb;
                else api().url(scene.path).then((url) => { if (url) { scene.thumb = url; media.src = url; } });
            }
            card.querySelector('.mv-up').onclick = () => moveScene(index, -1);
            card.querySelector('.mv-down').onclick = () => moveScene(index, 1);
            card.querySelector('.mv-del').onclick = () => { state.scenes.splice(index, 1); persist(); renderScenes(); };

            const field = (host, key, placeholder, small) => {
                const input = document.createElement('input');
                input.className = `rounded-lg bg-white/5 border border-white/10 px-2 py-1.5 ${small ? 'text-[11px]' : 'text-xs'} text-white`;
                input.placeholder = placeholder;
                input.value = scene[key] || '';
                input.oninput = () => { scene[key] = input.value; persist(); };
                host.appendChild(input);
                return input;
            };
            const texts = card.querySelector('.mv-texts');
            if (isTitle) {
                field(texts, 'title', 'Big title, e.g. DRAGONFALL');
                field(texts, 'subtitle', 'Smaller line under it (optional)', true);
            } else {
                field(texts, 'caption', 'Caption shown at the bottom (optional)');
                field(texts, 'title', 'Big title over this scene (optional), e.g. CHAPTER ONE', true);
            }

            const extra = card.querySelector('.mv-extra');
            if (isImage || isTitle) {
                extra.innerHTML = `
                    <label class="flex items-center gap-2">On screen <b class="mv-dur-label text-white">${scene.duration}</b> s
                        <input type="range" class="mv-dur accent-primary" min="${isTitle ? 1.5 : 2}" max="12" step="0.5" value="${scene.duration}"></label>
                    ${isTitle
                        ? `<label class="flex items-center gap-2">Background <input type="color" class="mv-color w-8 h-6 rounded bg-transparent" value="${escapeHtml(scene.color || '#0b0f1a')}"></label>
                           <label class="flex items-center gap-1.5" title="No background: the text appears over the next scene instead of on a card of its own"><input type="checkbox" class="mv-transparent accent-primary" ${scene.transparent ? 'checked' : ''}> Transparent (text over the next scene)</label>
                           <span class="flex items-center gap-1.5"><select class="mv-export-format rounded-lg bg-white/5 border border-white/10 px-1.5 py-1 text-xs text-white"><option value="mov">ProRes 4444 (.mov)</option><option value="webm">WebM alpha (.webm)</option></select>
                           <button class="mv-export-title px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold" title="Saves the title as a video with a transparent background, for DaVinci Resolve, Premiere…">Export transparent clip…</button></span>`
                        : `<label class="flex items-center gap-2">Camera
                            <select class="mv-motion rounded-lg bg-white/5 border border-white/10 px-2 py-1 text-xs text-white">${MOTIONS.map(([v, l]) => option(v, l, v === scene.motion)).join('')}</select></label>
                           <input class="mv-prompt flex-1 min-w-[180px] rounded-lg bg-white/5 border border-white/10 px-2 py-1 text-xs text-white" placeholder="Movement for AI animation, e.g. “she turns and smiles, hair moving in the wind”">
                           <button class="mv-animate px-3 py-1.5 rounded-lg bg-primary/20 border border-primary/40 text-primary text-xs font-bold hover:bg-primary/30 disabled:opacity-40">✨ Animate</button>`}`;
                const dur = extra.querySelector('.mv-dur');
                dur.oninput = () => { scene.duration = Number(dur.value); extra.querySelector('.mv-dur-label').textContent = dur.value; persist(); renderTotal(); };
                const color = extra.querySelector('.mv-color');
                if (color) color.oninput = () => { scene.color = color.value; persist(); };
                const transparent = extra.querySelector('.mv-transparent');
                if (transparent) transparent.onchange = () => { scene.transparent = transparent.checked; persist(); renderTotal(); };
                const exportButton = extra.querySelector('.mv-export-title');
                if (exportButton) {
                    exportButton.onclick = async () => {
                        showError('');
                        const [width, height] = state.format.split('x').map(Number);
                        exportButton.disabled = true;
                        try {
                            const saved = await api().exportTitle({ title: scene.title, subtitle: scene.subtitle, titleStyle: scene.titleStyle, titleColor: scene.titleColor, seconds: scene.duration, width, height, fps: state.fps, format: extra.querySelector('.mv-export-format').value });
                            if (saved) els.meta.textContent = `Transparent title saved: ${saved}`, els.meta.classList.remove('hidden');
                        } catch (err) { showError(err.message); } finally { exportButton.disabled = false; }
                    };
                }
                const motion = extra.querySelector('.mv-motion');
                if (motion) motion.onchange = () => { scene.motion = motion.value; persist(); };
                const prompt = extra.querySelector('.mv-prompt');
                if (prompt) { prompt.value = scene.prompt || ''; prompt.oninput = () => { scene.prompt = prompt.value; persist(); }; }
                const animate = extra.querySelector('.mv-animate');
                if (animate) {
                    animate.disabled = !!animatingId || rendering || !els.animateModel.value;
                    animate.onclick = () => animateScene(scene, animate);
                }
            } else {
                extra.innerHTML = `
                    <span>Length <b class="text-white">${scene.duration ? scene.duration.toFixed(1) : '?'}</b> s</span>
                    <label class="flex items-center gap-2" title="Cut the clip short (0 = whole clip)">Use only the first
                        <input type="number" class="mv-trim w-16 rounded-lg bg-white/5 border border-white/10 px-2 py-1 text-xs text-white" min="0" step="0.5" value="${scene.trimEnd || ''}" placeholder="all"> s</label>`;
                const trim = extra.querySelector('.mv-trim');
                trim.onchange = () => { scene.trimEnd = Math.max(0, Number(trim.value) || 0); persist(); renderTotal(); };
            }

            // Transition into this scene, and how its texts look.
            const styleRow = card.querySelector('.mv-style-row');
            const pick = (label, list, key, fallbackLabel, title) => {
                const wrap = document.createElement('label');
                wrap.className = 'flex items-center gap-1.5';
                if (title) wrap.title = title;
                wrap.append(label);
                const select = document.createElement('select');
                select.className = 'rounded-lg bg-white/5 border border-white/10 px-1.5 py-1 text-xs text-white max-w-[190px]';
                select.innerHTML = (fallbackLabel ? option('', fallbackLabel, !scene[key]) : '') + list.map(([v, l]) => option(v, l, v === scene[key])).join('');
                select.onchange = () => { if (select.value) scene[key] = select.value; else delete scene[key]; persist(); renderTotal(); };
                wrap.appendChild(select);
                styleRow.appendChild(wrap);
            };
            if (index > 0) pick('Transition in', TRANSITIONS, 'transitionIn', 'Same as the project', 'How this scene replaces the previous one');
            if (isTitle || String(scene.title || '').trim()) {
                pick('Title style', TITLE_STYLES, 'titleStyle', null);
                const colorWrap = document.createElement('label');
                colorWrap.className = 'flex items-center gap-1.5';
                colorWrap.append('Color');
                const color = document.createElement('input');
                color.type = 'color';
                color.className = 'w-7 h-6 rounded bg-transparent';
                color.value = scene.titleColor || '#ffffff';
                color.oninput = () => { scene.titleColor = color.value; persist(); };
                colorWrap.appendChild(color);
                styleRow.appendChild(colorWrap);
            }
            if (!isTitle) pick('Caption style', CAPTION_STYLES, 'captionStyle', null);

            // Redo a generated shot with a new description (the old take stays available).
            const redo = card.querySelector('.mv-redo');
            const canRedo = scene.kind === 'video' && window.localAI.h3 && (scene.gen || director.refs.length);
            if (canRedo) {
                redo.innerHTML = `<textarea class="mv-redo-story w-full min-h-[54px] rounded-lg bg-white/5 border border-white/10 p-2 text-xs text-white" placeholder="What happens in this shot. Be explicit about who moves, e.g. “the Archer stays still, the Commander walks up to her”."></textarea>
                    <div class="flex flex-wrap items-center gap-2 text-xs text-secondary">
                        <input class="mv-redo-seed w-28 rounded-lg bg-white/5 border border-white/10 px-2 py-1 text-xs text-white" placeholder="seed (random)">
                        <label class="flex items-center gap-1.5" title="Uses the last frame of the previous shot as a reference. Good for one continuous action; otherwise the new shot tends to drift back to that picture."><input type="checkbox" class="mv-redo-continue accent-primary" ${scene.continuity ? 'checked' : ''}> continue from the previous shot</label>
                        <button class="mv-redo-go px-3 py-1.5 rounded-lg bg-primary/20 border border-primary/40 text-primary text-xs font-bold hover:bg-primary/30 disabled:opacity-40">↻ Redo this shot</button>
                        <span class="mv-redo-status"></span>
                    </div>
                    <div class="mv-takes flex flex-wrap items-end gap-2"></div>`;
                const story = redo.querySelector('.mv-redo-story');
                story.value = scene.gen?.story || scene.prompt || '';
                story.oninput = () => { scene.gen = { ...gensFor(scene), story: story.value }; persist(); };
                const cont = redo.querySelector('.mv-redo-continue');
                cont.onchange = () => { scene.continuity = cont.checked; persist(); };
                const go = redo.querySelector('.mv-redo-go');
                go.disabled = !!animatingId || rendering || directing;
                go.onclick = () => redoShot(scene, go, redo.querySelector('.mv-redo-seed'), redo.querySelector('.mv-redo-status'));
                // The versions of this shot: click one to use it.
                const takes = takesOf(scene);
                const strip = redo.querySelector('.mv-takes');
                if (takes.length > 1) {
                    const note = document.createElement('span');
                    note.className = 'basis-full text-[11px] text-secondary';
                    note.textContent = 'Versions of this shot (click one to use it, hover to preview):';
                    strip.appendChild(note);
                    takes.forEach((take, k) => {
                        const selected = k === (Number.isInteger(scene.takeIndex) ? scene.takeIndex : takes.length - 1);
                        const item = document.createElement('button');
                        item.type = 'button';
                        item.className = `relative w-32 rounded-lg overflow-hidden bg-black border-2 ${selected ? 'border-primary' : 'border-white/10 hover:border-white/40'}`;
                        item.title = selected ? 'In use' : 'Use this version';
                        item.innerHTML = `<video class="w-full aspect-video object-cover" muted preload="metadata" playsinline></video><span class="absolute bottom-0 inset-x-0 px-1 py-0.5 bg-black/70 text-[10px] text-left">${k === takes.length - 1 ? 'Newest' : k === takes.length - 2 ? 'Before it' : 'Oldest'} · ${Number(take.duration || 0).toFixed(1)} s${selected ? ' · in use' : ''}</span>`;
                        const video = item.querySelector('video');
                        api().url(take.path).then((url) => { if (url) video.src = `${url}#t=0.1`; });
                        item.onmouseenter = () => video.play().catch(() => {});
                        item.onmouseleave = () => { video.pause(); video.currentTime = 0.1; };
                        item.onclick = () => { if (!selected) useTake(scene, k); };
                        strip.appendChild(item);
                    });
                }
            }


            // Sound effect of this scene, made by the local audio model.
            const sfx = card.querySelector('.mv-sfx');
            if (scene.sfx?.path) {
                sfx.innerHTML = `<span class="text-white">🔊 ${escapeHtml(scene.sfx.prompt || 'sound effect')}</span><audio class="mv-sfx-audio h-7" controls preload="none"></audio><button class="mv-sfx-del underline hover:text-white">remove</button>`;
                api().url(scene.sfx.path).then((url) => { const a = sfx.querySelector('.mv-sfx-audio'); if (url && a) a.src = url; });
                sfx.querySelector('.mv-sfx-del').onclick = () => { delete scene.sfx; persist(); renderScenes(); };
            } else {
                sfx.innerHTML = `<input class="mv-sfx-prompt flex-1 min-w-[180px] rounded-lg bg-white/5 border border-white/10 px-2 py-1 text-xs text-white" placeholder="Sound effect for this scene, e.g. “sword clash and echoing roar”">
                    <button class="mv-sfx-make px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold disabled:opacity-40">🔊 Make sound</button>`;
                const input = sfx.querySelector('.mv-sfx-prompt');
                input.value = scene.sfxPrompt || '';
                input.oninput = () => { scene.sfxPrompt = input.value; persist(); };
                const make = sfx.querySelector('.mv-sfx-make');
                make.disabled = !!animatingId || rendering || !!audioBusy;
                make.onclick = () => makeSceneSound(scene, make);
            }
            els.scenes.appendChild(card);
        });
        renderTotal();
    }

    // ── Animate a picture (Wan2GP image-to-video) ───────────────────
    async function loadAnimateModels() {
        try {
            const models = await window.localAI.wan2gp.listModels();
            const usable = models.filter((m) => m.type === 'video' && m.needsImage && !m.needsAudio && !m.lipsync && m.ready);
            els.animateModel.innerHTML = usable.length
                ? usable.map((m) => option(m.id, `${m.name}${m.needsDownload ? ' (downloads first)' : ''}`, m.id === state.animateModel)).join('')
                : '<option value="">No image-to-video model ready (set up Wan2GP in Settings → Local Models)</option>';
            if (!usable.some((m) => m.id === state.animateModel)) state.animateModel = usable[0]?.id || '';
            els.animateModel.value = state.animateModel;
            els.animateModel._models = usable;
        } catch {
            els.animateModel.innerHTML = '<option value="">Wan2GP is not available</option>';
        }
        renderScenes();
    }
    els.animateModel.onchange = () => { state.animateModel = els.animateModel.value; persist(); };

    // ── Local audio (Stable Audio 3 through Wan2GP): music and sound effects ─────────
    let audioBusy = '';
    async function makeAudio(kind, prompt, seconds, onLabel) {
        const model = kind === 'music' ? 'wan2gp:stable-audio3-music' : 'wan2gp:stable-audio3-sfx';
        const off = window.localAI.onProgress((e) => {
            if (!e) return;
            const pct = e.progress != null ? ` ${Math.round(e.progress * 100)}%` : '';
            onLabel?.(e.message || `${e.status === 'downloading' ? 'Downloading the audio model…' : kind === 'music' ? 'Composing…' : 'Making the sound…'}${pct}`);
        });
        audioBusy = kind;
        try {
            const result = await window.localAI.wan2gp.generate({ model, prompt, duration_seconds: Math.max(2, Math.min(120, Math.ceil(seconds))) });
            if (!result?.path) throw new Error('The audio model returned no file.');
            return result.path;
        } finally {
            off?.();
            audioBusy = '';
        }
    }
    async function makeSceneSound(scene, button) {
        showError('');
        const prompt = (scene.sfxPrompt || '').trim();
        if (!prompt) { showError('Describe the sound first.'); return; }
        button.disabled = true;
        const original = button.textContent;
        try {
            scene.sfx = { path: await makeAudio('sfx', prompt, Math.min(10, Math.max(3, sceneSeconds(scene) + 1)), (m) => { button.textContent = m; }), prompt, volume: 0.9 };
            persist();
        } catch (err) { showError(`Sound failed: ${err.message}`); button.textContent = original; }
        renderScenes();
    }

    // Quality choice → H3 settings. A redo uses the current choice, so one shot can be upgraded to "sharper" later.
    const shotQuality = () => ({ standard: { megapixels: 0.3, upscale: false }, sharp: { megapixels: 0.3, upscale: true, upscaleMegapixels: 0.6 }, best: { megapixels: 0.4, upscale: true, upscaleMegapixels: 0.8 } }[dir.quality.value] || { megapixels: 0.3, upscale: false });

    // ── Redo one shot (MiniMax H3) without touching the rest of the movie ─────────
    // The last 3 versions ("takes") of a shot stay available: pick the newest, the one before, or the one before that.
    const MAX_TAKES = 3;
    function takesOf(scene) {
        if (!Array.isArray(scene.takes)) { // older projects kept only a list of previous versions
            scene.takes = [...(scene.previous || []), { path: scene.path, duration: scene.duration }].slice(-MAX_TAKES);
            scene.takeIndex = scene.takes.length - 1;
            delete scene.previous;
        }
        return scene.takes;
    }
    function addTake(scene, take) {
        const takes = takesOf(scene);
        takes.push(take);
        while (takes.length > MAX_TAKES) takes.shift();
        scene.takeIndex = takes.length - 1;
    }
    async function useTake(scene, index) {
        const take = takesOf(scene)[index];
        if (!take) return;
        scene.takeIndex = index;
        scene.path = take.path;
        scene.duration = take.duration;
        scene.thumb = await api().url(take.path);
        persist();
        renderScenes();
    }

    // How a shot was made; shots made before this was saved use the director's references and the scene text.
    const gensFor = (scene) => scene.gen || {
        engine: 'h3', story: scene.prompt || '', style: dir.style.value, sound: scene.sfxPrompt || '', seconds: Math.round(scene.duration) || 6,
        refs: director.refs.map((r, k) => ({ path: r.path, role: r.role, name: refName(r, k), sheet: !!r.sheet })),
    };
    async function redoShot(scene, button, seedInput, statusEl) {
        showError('');
        const gen = gensFor(scene);
        if (!gen.refs.length) { showError('Add the reference pictures in the AI director panel first.'); return; }
        if (!String(gen.story || '').trim()) { showError('Describe what happens in the shot first.'); return; }
        const seed = /^[0-9]+$/.test(seedInput.value.trim()) ? Number(seedInput.value.trim()) : undefined;
        animatingId = scene.id;
        renderTotal();
        button.disabled = true;
        const label = (text) => { statusEl.textContent = text; };
        label('starting…');
        const off = window.localAI.h3.onEvent((e) => {
            if (e.type === 'progress') label(`rendering, step ${e.value}/${e.max}`);
            else if (e.type === 'status' && e.message) label(e.message);
        });
        try {
            // Continuity: the shot before this one (when it is a video) gives its last frame.
            const before = state.scenes[state.scenes.indexOf(scene) - 1];
            let frame = null;
            if (scene.continuity && before?.kind === 'video') { try { frame = (await api().lastFrame(before.path)).path; } catch { /* made without it */ } }
            const refs = mergeContinuityRef(gen.refs, frame);
            const result = await window.localAI.h3.generate({
                images: refs.map((r, k) => ({ name: `ref-${k}.png`, path: r.path })),
                spec: { refs: refs.map((r) => ({ role: r.role, name: r.name, sheet: !!r.sheet, tag: r.name })), story: withContinuityStory(gen.story, refs), style: gen.style, sound: gen.sound || '', voices: false },
                seconds: gen.seconds || 6, ...shotQuality(), audio: 'on', seed,
            });
            const [info] = await api().probe([result.path]);
            takesOf(scene); // keeps the version being replaced
            addTake(scene, { path: result.path, duration: info?.duration || scene.duration });
            scene.gen = gen;
            scene.path = result.path;
            scene.duration = info?.duration || scene.duration;
            scene.thumb = await api().url(result.path);
            persist();
        } catch (err) {
            if (!/cancel/i.test(err.message)) showError(`Could not redo the shot: ${err.message}`);
        } finally {
            off?.();
            animatingId = null;
            renderScenes();
        }
    }
    // Turns a picture scene into a video scene (image-to-video). Throws when no model is ready or the run fails.
    async function animateCore(scene, onLabel) {
        const model = (els.animateModel._models || []).find((m) => m.id === state.animateModel);
        if (!model) throw new Error('Choose an image-to-video model first.');
        animatingId = scene.id;
        const off = window.localAI.onProgress((e) => {
            if (!e || e.progress == null) return;
            onLabel?.(`animating ${Math.round(e.progress * 100)}%`);
        });
        try {
            const params = { model: model.id, prompt: scene.prompt || 'subtle natural motion, cinematic', aspect_ratio: aspectRatioParam(state.format), image: scene.path };
            // Wan runs at 16 fps with 4n+1 frames.
            if (model.family === 'wan') params.video_length = Math.round((state.animateSeconds * 16) / 4) * 4 + 1;
            const result = await window.localAI.wan2gp.generate(params);
            if (!result?.path) throw new Error('The model returned no video.');
            const [info] = await api().probe([result.path]);
            scene.originalPicture = scene.path;
            scene.path = result.path;
            scene.kind = 'video';
            scene.duration = info?.duration || state.animateSeconds;
            scene.thumb = await api().url(result.path);
            persist();
        } finally {
            off?.();
            animatingId = null;
        }
    }
    async function animateScene(scene, button) {
        showError('');
        button.textContent = 'Animating…';
        renderTotal();
        try {
            await animateCore(scene, (m) => { button.textContent = `Animating… ${m.replace('animating ', '')}`; });
        } catch (err) {
            showError(/cancel/i.test(err.message) ? '' : `Animation failed: ${err.message}`);
        } finally {
            renderScenes();
        }
    }

    // ── Pickers ───────────────────────────────────────────────
    function closePicker() { els.picker.classList.add('hidden'); els.picker.innerHTML = ''; }
    function openPicker(title, items, onChoose) {
        els.picker.classList.remove('hidden');
        els.picker.innerHTML = `<div class="flex items-center gap-2 mb-2"><span class="text-xs font-bold text-secondary flex-1">${title}</span><button class="mv-pick-add hidden px-3 py-1.5 rounded-lg bg-primary text-black text-xs font-bold">Add selected</button><button class="mv-pick-close text-xs text-secondary hover:text-white underline">Close</button></div><div class="mv-pick-grid grid grid-cols-3 md:grid-cols-5 gap-2"></div>`;
        const grid = els.picker.querySelector('.mv-pick-grid');
        const addButton = els.picker.querySelector('.mv-pick-add');
        const chosen = new Set();
        if (!items.length) grid.innerHTML = '<p class="col-span-full text-xs text-secondary">Nothing here yet.</p>';
        items.forEach((item) => {
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'relative aspect-video rounded-lg overflow-hidden bg-black border-2 border-transparent';
            cell.innerHTML = `${item.isImage ? '<img class="w-full h-full object-cover" alt="">' : '<video class="w-full h-full object-cover" muted preload="metadata"></video>'}<span class="absolute bottom-0 inset-x-0 px-1 py-0.5 bg-black/70 text-[10px] truncate text-left">${item.label || ''}</span>`;
            cell.querySelector(item.isImage ? 'img' : 'video').src = item.url;
            cell.onclick = () => {
                if (chosen.has(item)) { chosen.delete(item); cell.classList.remove('border-primary'); } else { chosen.add(item); cell.classList.add('border-primary'); }
                addButton.classList.toggle('hidden', !chosen.size);
                addButton.textContent = `Add ${chosen.size} selected`;
            };
            grid.appendChild(cell);
        });
        addButton.onclick = async () => { const list = [...chosen]; closePicker(); await onChoose(list); };
        els.picker.querySelector('.mv-pick-close').onclick = closePicker;
    }
    $('.mv-add-library').onclick = async () => {
        const items = await api().library();
        openPicker('Clips made in the app (newest first)', items.map((i) => ({ ...i, label: `${i.source} · ${new Date(i.modifiedAt).toLocaleString()}` })), (list) => addMany(list.map((i) => ({ path: i.path, label: i.label }))));
    };
    $('.mv-add-images').onclick = async () => addMany(await api().pick('image'));
    $('.mv-add-videos').onclick = async () => addMany(await api().pick('video'));
    // Pictures made in the Image Studio (their history), as a picker; `handler` gets the chosen entries.
    function openHistoryPicker(title, handler) {
        let history = [];
        try { history = JSON.parse(localStorage.getItem('muapi_history') || '[]'); } catch { /* ignore */ }
        // Entries saved without their picture only have a file path; the others carry the picture itself.
        const items = history.filter((e) => e.url || e.path).slice(0, 60).map((e) => ({ ...e, isImage: true, label: (e.prompt || '').slice(0, 40) }));
        Promise.all(items.map(async (e) => ({ ...e, url: e.url || (e.path ? await api().url(e.path) : '') }))).then((withUrls) => {
            openPicker(title, withUrls.filter((e) => e.url), handler);
        });
    }
    // A history entry as a file on disk.
    async function historyFile(e) {
        if (e.path && IMAGE_RE.test(e.path)) return e.path;
        const blob = await (await fetch(e.url)).blob();
        const saved = await api().importBytes({ name: `image.${(blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, type: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) });
        return saved.path;
    }
    $('.mv-add-history').onclick = () => openHistoryPicker('Pictures from the Image Studio history', async (list) => {
        const resolved = [];
        for (const e of list) { try { resolved.push({ path: await historyFile(e), kind: 'image', prompt: e.translatedPrompt || e.prompt }); } catch (err) { showError(err.message); } }
        await addMany(resolved);
    });
    $('.mv-add-title').onclick = () => {
        state.scenes.push({ id: newId(), kind: 'title', path: '', title: 'TITLE', subtitle: '', duration: 3, color: '#0b0f1a', caption: '', motion: 'none' });
        persist();
        renderScenes();
    };
    $('.mv-clear').onclick = () => { if (state.scenes.length && confirm('Remove all scenes from the timeline? (The files stay on disk.)')) { state.scenes = []; persist(); renderScenes(); } };

    // ── Settings ──────────────────────────────────────────────
    els.format.onchange = () => { state.format = els.format.value; persist(); };
    els.transition.onchange = () => { state.transition = els.transition.value; persist(); renderTotal(); };
    els.tsec.oninput = () => { state.transitionSeconds = Number(els.tsec.value); els.tsecLabel.textContent = els.tsec.value; persist(); renderTotal(); };
    els.fps.onchange = () => { state.fps = Number(els.fps.value); persist(); };
    els.keep.onchange = () => { state.keepAudio = els.keep.checked; persist(); };
    els.fade.onchange = () => { state.fadeInOut = els.fade.checked; persist(); };
    els.mvol.oninput = () => { state.musicVolume = Number(els.mvol.value); els.mvolLabel.textContent = Math.round(state.musicVolume * 100); persist(); };
    els.asec.oninput = () => { state.animateSeconds = Number(els.asec.value); els.asecLabel.textContent = els.asec.value; persist(); };
    function renderMusic() {
        els.musicName.textContent = state.music ? basename(state.music) : 'none';
        els.musicClear.classList.toggle('hidden', !state.music);
        els.musicAudio.classList.toggle('hidden', !state.music);
        if (state.music) api().url(state.music).then((url) => { if (url) els.musicAudio.src = url; });
    }
    els.musicMake.onclick = async () => {
        showError('');
        const prompt = els.musicPrompt.value.trim();
        if (!prompt) { showError('Describe the music first.'); return; }
        els.musicMake.disabled = true;
        const original = els.musicMake.textContent;
        try {
            state.music = await makeAudio('music', prompt, Math.min(120, Math.max(10, totalSeconds() + 2)), (m) => { els.musicMake.textContent = m; });
            persist();
            renderMusic();
        } catch (err) { showError(`Music failed: ${err.message}`); } finally { els.musicMake.disabled = false; els.musicMake.textContent = original; }
    };
    els.musicPick.onclick = async () => { const [file] = await api().pick('audio'); if (file) { state.music = file; persist(); renderMusic(); } };
    els.musicClear.onclick = () => { state.music = null; persist(); renderMusic(); };

    // ── Render ──────────────────────────────────────────────
    function setRendering(on) {
        rendering = on;
        els.render.classList.toggle('hidden', on);
        els.preview.classList.toggle('hidden', on);
        els.cancel.classList.toggle('hidden', !on);
        els.progress.classList.toggle('hidden', !on);
        renderTotal();
        renderScenes();
    }
    async function render(quality = 'final') {
        showError('');
        const [width, height] = state.format.split('x').map(Number);
        const project = {
            width, height, fps: state.fps, transition: state.transition, transitionSeconds: state.transitionSeconds,
            keepClipAudio: state.keepAudio, fadeInOut: state.fadeInOut, quality,
            music: state.music ? { path: state.music, volume: state.musicVolume } : undefined,
            clips: foldTransparentTitles(state.scenes).map((s) => ({ path: s.path, kind: s.kind, duration: s.kind === 'video' ? undefined : s.duration, trimEnd: s.kind === 'video' && s.trimEnd > 0 ? s.trimEnd : undefined, motion: s.motion, caption: s.caption, title: s.title, subtitle: s.subtitle, color: s.color, transitionIn: s.transitionIn, titleStyle: s.titleStyle, titleColor: s.titleColor, captionStyle: s.captionStyle, sfx: s.sfx?.path ? { path: s.sfx.path, volume: s.sfx.volume } : undefined })),
        };
        els.bar.style.width = '0%';
        els.percent.textContent = '0%';
        els.video.pause();
        setRendering(true);
        const started = Date.now();
        try {
            const result = await api().render(project);
            if (quality === 'final') { lastMovie = result; showUpscalePanel(); }
            els.video.src = result.url;
            els.video.classList.remove('hidden');
            els.empty.classList.add('hidden');
            els.video.play().catch(() => {});
            els.save.classList.toggle('hidden', quality !== 'final' && !lastMovie);
            els.reveal.classList.toggle('hidden', quality !== 'final' && !lastMovie);
            els.meta.textContent = `${quality === 'preview' ? 'PREVIEW (half size) · ' : ''}${fmtTime(result.seconds)} · ${result.width}×${result.height} · ${(result.bytes / 1048576).toFixed(1)} MB · made in ${Math.round((Date.now() - started) / 1000)} s`;
            els.meta.classList.remove('hidden');
        } catch (err) {
            if (!/cancel/i.test(err.message)) showError(err.message);
        } finally {
            setRendering(false);
        }
    }
    els.render.onclick = () => render('final');
    els.preview.onclick = () => render('preview');
    els.cancel.onclick = () => { api().cancel(); api().cancelUpscale(); };

    // ── Final upscale ───────────────────────────────────────────
    const showUpscalePanel = () => els.upPanel.classList.toggle('hidden', !lastMovie);
    async function loadUpscaleModels() {
        const { models } = await api().upscaleModels();
        // Measured on this kind of video: Real-ESRGAN ≈ 15 min for a 36 s movie, UltraSharp ≈ 2 hours.
        const speed = (m) => (/ultrasharp/i.test(m) ? 2 : /esrgan/i.test(m) ? 0 : 1);
        const hint = (m) => (/ultrasharp/i.test(m) ? ' — best detail, VERY slow (hours)' : /anime/i.test(m) ? ' — fast (minutes), made for flat anime art: smooths faces' : /esrgan/i.test(m) ? ' — fast (minutes)' : '');
        const ranked = [...models].sort((a, b) => speed(a) - speed(b));
        els.upModel.innerHTML = ranked.length ? ranked.map((m) => option(m, m + hint(m), false)).join('') : '<option value="">No upscale model in ComfyUI/models/upscale_models</option>';
        const noAi = !ranked.length;
        els.upMethod.querySelector('option[value="ai"]').disabled = noAi;
        if (noAi) els.upMethod.value = 'fast';
        syncUpscaleControls();
    }
    function syncUpscaleControls() {
        const ai = els.upMethod.value === 'ai';
        els.upModelWrap.classList.toggle('hidden', !ai);
        els.upStrengthWrap.classList.toggle('hidden', !ai);
    }
    els.upMethod.onchange = syncUpscaleControls;
    els.upStrength.oninput = () => { els.upStrengthLabel.textContent = els.upStrength.value; };
    els.upGo.onclick = async () => {
        showError('');
        if (!lastMovie) return;
        els.bar.style.width = '0%';
        els.percent.textContent = '';
        els.phase.textContent = 'Upscaling…';
        setRendering(true);
        const started = Date.now();
        try {
            const result = await api().upscale({ input: lastMovie.path, target: els.upTarget.value, method: els.upMethod.value, model: els.upModel.value, strength: Number(els.upStrength.value) / 100 });
            lastMovie = result;
            els.video.src = result.url;
            els.video.classList.remove('hidden');
            els.empty.classList.add('hidden');
            els.video.play().catch(() => {});
            els.meta.textContent = `UPSCALED · ${fmtTime(result.seconds)} · ${result.width}×${result.height} · ${(result.bytes / 1048576).toFixed(1)} MB · made in ${Math.round((Date.now() - started) / 1000)} s`;
            els.meta.classList.remove('hidden');
        } catch (err) {
            if (!/cancel/i.test(err.message)) showError(err.message);
        } finally {
            setRendering(false);
            els.phase.textContent = 'Rendering…';
        }
    };
    els.save.onclick = async () => {
        if (!lastMovie) return;
        try { const out = await api().saveAs(lastMovie.path); if (out) els.meta.textContent += ` · saved to ${out}`; } catch (err) { showError(err.message); }
    };
    els.reveal.onclick = () => { if (lastMovie) api().reveal(lastMovie.path); };
    unsubscribe = api().onEvent((e) => {
        if (e.type === 'status' && e.message) els.phase.textContent = e.message;
        if (e.type === 'progress') {
            els.bar.style.width = `${Math.round(e.progress * 100)}%`;
            els.percent.textContent = `${Math.round(e.progress * 100)}%`;
        }
    });

    // ── AI director: idea → storyboard → pictures, titles, sounds, music → movie ─────────
    const director = { title: '', music: '', shots: [], refs: [] };
    // The storyboard and the reference pictures survive a restart (so a shot can still be redone later).
    try {
        const saved = JSON.parse(localStorage.getItem('movie-director-v1') || 'null');
        if (saved) { director.title = saved.title || ''; director.music = saved.music || ''; director.shots = saved.shots || []; director.refs = (saved.refs || []).map((r) => ({ ...r, thumb: '' })); }
    } catch { /* nothing saved */ }
    const saveDirector = () => {
        try { localStorage.setItem('movie-director-v1', JSON.stringify({ title: director.title, music: director.music, shots: director.shots, refs: director.refs.map(({ thumb, ...r }) => r) })); } catch { /* storage unavailable */ }
    };
    let directing = false;
    let stopDirector = false;
    const dir = {
        idea: $('.mv-idea'), n: $('.mv-shots-n'), style: $('.mv-style'), model: $('.mv-pic-model'), titles: $('.mv-opt-titles'), sfx: $('.mv-opt-sfx'),
        music: $('.mv-opt-music'), continuity: $('.mv-opt-continuity'), engine: $('.mv-engine'), shotSec: $('.mv-shot-sec'), quality: $('.mv-shot-quality'), shotSecLabel: $('.mv-shot-sec-label'), refs: $('.mv-refs'), addRef: $('.mv-add-ref'), write: $('.mv-write'), produce: $('.mv-produce'), stop: $('.mv-dir-stop'),
        status: $('.mv-dir-status'), shots: $('.mv-shots'),
    };
    try { dir.idea.value = localStorage.getItem('movie-idea') || ''; } catch { /* storage unavailable */ }
    dir.idea.oninput = () => { try { localStorage.setItem('movie-idea', dir.idea.value); } catch { /* storage unavailable */ } };
    const dirStatus = (text) => { dir.status.textContent = text || ''; };
    const dirBusy = (on) => {
        directing = on;
        dir.write.disabled = on;
        dir.produce.disabled = on || !director.shots.length;
        dir.stop.classList.toggle('hidden', !on);
    };

    async function loadPictureModels() {
        try {
            const models = await localAI.listModels();
            const usable = models.filter((m) => (m.provider === 'sdcpp' ? m.state === 'downloaded' && m.fit !== 'unfit' : m.provider === 'wan2gp' && m.type === 'image' && !m.edit && m.ready && m.downloaded));
            usable.sort((a, b) => Number(!!a.legacy) - Number(!!b.legacy) || Number(b.featured || 0) - Number(a.featured || 0));
            dir.model.innerHTML = usable.length
                ? usable.map((m) => option(m.id, m.name, false)).join('')
                : '<option value="">No picture model downloaded (Settings → Local Models)</option>';
        } catch { dir.model.innerHTML = '<option value="">Local models not available</option>'; }
    }

    const ROLE_LIST = [['character', 'Character'], ['place', 'Place'], ['object', 'Object']];
    const refName = (ref, index) => (ref.name || '').trim() || `${ROLE_LIST.find(([v]) => v === ref.role)?.[1] || 'Reference'} ${index + 1}`;
    function renderRefsBox() { dir.refs.closest('.mv-refs-box').classList.toggle('hidden', dir.engine.value !== 'h3'); }
    function renderRefs() {
        dir.refs.innerHTML = '';
        director.refs.forEach((ref, index) => {
            const card = document.createElement('div');
            card.className = 'rounded-xl bg-white/5 border border-white/10 p-2 flex flex-col gap-1.5';
            card.innerHTML = `<div class="relative aspect-video rounded-lg overflow-hidden bg-black/40"><img class="w-full h-full object-contain" alt=""><button class="mv-ref-del absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 hover:bg-red-500/80 text-xs" title="Remove">✕</button></div>
                <div class="flex gap-1"><select class="mv-ref-role rounded-lg bg-white/5 border border-white/10 px-1 py-1 text-xs text-white">${ROLE_LIST.map(([v, l]) => option(v, l, v === ref.role)).join('')}</select>
                <input class="mv-ref-name min-w-0 flex-1 rounded-lg bg-white/5 border border-white/10 px-2 py-1 text-xs text-white" placeholder="Name, e.g. Commander"></div>
                <label class="flex items-center gap-1.5 text-[10px] text-secondary" title="The picture shows the same character or place from several sides"><input type="checkbox" class="mv-ref-sheet accent-primary"> contact sheet (several views)</label>`;
            card.querySelector('img').src = ref.thumb;
            const name = card.querySelector('.mv-ref-name');
            name.value = ref.name;
            name.oninput = () => { ref.name = name.value; saveDirector(); };
            card.querySelector('.mv-ref-role').onchange = (e) => { ref.role = e.target.value; saveDirector(); };
            const sheet = card.querySelector('.mv-ref-sheet');
            sheet.checked = !!ref.sheet;
            sheet.onchange = () => { ref.sheet = sheet.checked; saveDirector(); };
            card.querySelector('.mv-ref-del').onclick = () => { director.refs.splice(index, 1); renderRefs(); renderShots(); };
            dir.refs.appendChild(card);
        });
        renderRefsBox();
        saveDirector();
        renderScenes(); // shots can be redone once there are references
    }


    function renderShots() {
        dir.shots.innerHTML = '';
        if (director.title || director.music) {
            const head = document.createElement('div');
            head.className = 'rounded-xl border border-white/10 bg-white/[0.03] p-3 flex flex-col gap-2';
            head.innerHTML = '<input class="mv-d-title rounded-lg bg-white/5 border border-white/10 px-2 py-1.5 text-sm font-bold text-white" placeholder="Title"><input class="mv-d-music rounded-lg bg-white/5 border border-white/10 px-2 py-1.5 text-xs text-white" placeholder="Music prompt (English)">';
            const title = head.querySelector('.mv-d-title');
            const music = head.querySelector('.mv-d-music');
            title.value = director.title;
            music.value = director.music;
            title.oninput = () => { director.title = title.value; saveDirector(); };
            music.oninput = () => { director.music = music.value; saveDirector(); };
            dir.shots.appendChild(head);
        }
        director.shots.forEach((shot, i) => {
            const card = document.createElement('div');
            card.className = 'rounded-xl border border-white/10 bg-white/[0.03] p-3 flex flex-col gap-1.5';
            card.innerHTML = `<span class="text-[11px] font-bold text-primary">Shot ${i + 1}</span>`;
            if (director.refs.length && dir.engine.value === 'h3') {
                const row = document.createElement('div');
                row.className = 'flex flex-wrap gap-3 text-[11px] text-secondary';
                if (!Array.isArray(shot.refs)) shot.refs = director.refs.map((_, k) => k).slice(0, 4);
                director.refs.forEach((ref, k) => {
                    const label = document.createElement('label');
                    label.className = 'flex items-center gap-1';
                    label.innerHTML = '<input type="checkbox" class="accent-primary"> <span></span>';
                    const box = label.querySelector('input');
                    label.querySelector('span').textContent = refName(ref, k);
                    box.checked = shot.refs.includes(k);
                    box.onchange = () => { shot.refs = box.checked ? [...new Set([...shot.refs, k])] : shot.refs.filter((x) => x !== k); };
                    row.appendChild(label);
                });
                card.appendChild(row);
            }
            for (const [key, label] of [['image', 'Picture prompt'], ['motion', 'Motion'], ['caption', 'Caption'], ['sound', 'Sound effect']]) {
                const input = document.createElement('input');
                input.className = 'rounded-lg bg-white/5 border border-white/10 px-2 py-1 text-xs text-white';
                input.placeholder = label;
                input.title = label;
                input.value = shot[key] || '';
                input.oninput = () => { shot[key] = input.value; saveDirector(); };
                card.appendChild(input);
            }
            dir.shots.appendChild(card);
        });
        dir.produce.disabled = directing || !director.shots.length;
        saveDirector();
    }

    dir.write.onclick = async () => {
        showError('');
        if (!dir.idea.value.trim()) { showError('Write the idea of the movie first.'); return; }
        dirBusy(true);
        dirStatus('The AI is writing the storyboard…');
        const off = window.localAI.onProgress((e) => { if (e?.message) dirStatus(e.message); });
        try {
            const result = await window.localAI.storyboard({ idea: dir.idea.value, scenes: Number(dir.n.value) || 6, style: dir.style.value, aspect: aspectRatioParam(state.format), refs: director.refs.map((r, k) => ({ role: r.role, name: refName(r, k), notes: r.notes })) });
            director.title = result.title;
            director.music = result.music;
            director.shots = result.scenes;
            dirStatus(`${result.scenes.length} shots written. Edit them if you like, then press “Produce the whole movie”.`);
        } catch (err) { showError(err.message); dirStatus(''); } finally { off?.(); dirBusy(false); renderShots(); }
    };

    const importedImage = async (res) => {
        if (res.path && IMAGE_RE.test(res.path)) return res.path;
        const blob = await (await fetch(res.url)).blob();
        const saved = await api().importBytes({ name: `shot.${(blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, type: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) });
        return saved.path;
    };
    const checkStop = () => { if (stopDirector) throw new Error('Stopped'); };

    dir.produce.onclick = async () => {
        showError('');
        if (!director.shots.length) return;
        if (dir.engine.value !== 'h3' && !dir.model.value) { showError('Download a picture model first (Settings → Local Models).'); return; }
        stopDirector = false;
        dirBusy(true);
        state.scenes = [];
        const motions = ['zoom-in', 'pan-right', 'zoom-out', 'pan-left'];
        const aspect = aspectRatioParam(state.format);
        const engine = dir.engine.value;
        if (engine === 'h3' && !director.refs.length) { showError('Add at least one reference picture (a character or a place) for the H3 engine.'); dirBusy(false); return; }
        try {
            if (dir.titles.checked && director.title) {
                state.scenes.push({ id: newId(), kind: 'title', path: '', title: director.title.toUpperCase(), subtitle: 'Official trailer', duration: 3.5, color: '#0b0f1a', caption: '', motion: 'none' });
                renderScenes();
            }
            let previousClip = null; // path of the clip made for the previous shot
            for (const [i, shot] of director.shots.entries()) {
                checkStop();
                const total = director.shots.length;
                let scene;
                if (engine === 'h3') {
                    // Real video from the reference sheets: characters and places move, with sound.
                    const picked = (Array.isArray(shot.refs) && shot.refs.length ? shot.refs : director.refs.map((_, k) => k)).filter((k) => director.refs[k]).slice(0, 4);
                    const base = picked.map((k) => director.refs[k]).map((r) => ({ path: r.path, role: r.role, name: refName(r, director.refs.indexOf(r)), sheet: !!r.sheet }));
                    let frame = null;
                    if (dir.continuity.checked && previousClip) { try { frame = (await api().lastFrame(previousClip)).path; } catch { /* no frame: the shot is made without it */ } }
                    const refs = mergeContinuityRef(base, frame);
                    const story = withContinuityStory([shot.image, shot.motion].filter(Boolean).join(' '), refs);
                    dirStatus(`Shot ${i + 1}/${total}: starting ComfyUI / MiniMax H3…`);
                    const offH3 = window.localAI.h3.onEvent((e) => {
                        if (e.type === 'progress') dirStatus(`Shot ${i + 1}/${total}: rendering, step ${e.value}/${e.max}`);
                        else if (e.type === 'status' && e.message) dirStatus(`Shot ${i + 1}/${total}: ${e.message}`);
                    });
                    let result;
                    try {
                        result = await window.localAI.h3.generate({
                            images: refs.map((r, k) => ({ name: `ref-${k}.png`, path: r.path })),
                            spec: {
                                refs: refs.map((r) => ({ role: r.role, name: r.name, sheet: !!r.sheet, tag: r.name })),
                                story, style: dir.style.value, sound: shot.sound || '', voices: false,
                            },
                            seconds: Number(dir.shotSec.value) || 6, ...shotQuality(), audio: 'on',
                        });
                    } finally { offH3?.(); }
                    checkStop();
                    const [info] = await api().probe([result.path]);
                    scene = { id: newId(), path: result.path, kind: 'video', duration: info?.duration || Number(dir.shotSec.value) || 6, motion: 'none', caption: shot.caption || '', prompt: shot.motion || '', trimEnd: 0, label: `Shot ${i + 1}`, sfxPrompt: shot.sound || '',
                        gen: { engine: 'h3', story: [shot.image, shot.motion].filter(Boolean).join(' '), style: dir.style.value, sound: shot.sound || '', seconds: Number(dir.shotSec.value) || 6, refs: base } };
                    scene.thumb = await api().url(result.path);
                    previousClip = result.path;
                } else {
                    dirStatus(`Shot ${i + 1}/${total}: painting the picture…`);
                    const off = window.localAI.onProgress((e) => { if (e?.progress != null && e.status !== 'done') dirStatus(`Shot ${i + 1}/${total}: painting ${Math.round(e.progress * 100)}%`); });
                    let file;
                    try {
                        const res = await localAI.generate({ model: dir.model.value, prompt: shot.image, aspect_ratio: aspect });
                        file = await importedImage(res);
                    } finally { off?.(); }
                    checkStop();
                    scene = { id: newId(), path: file, kind: 'image', duration: 4, motion: motions[i % motions.length], caption: shot.caption || '', prompt: shot.motion || '', trimEnd: 0, label: `Shot ${i + 1}`, sfxPrompt: shot.sound || '' };
                    scene.thumb = await api().url(file);
                }
                state.scenes.push(scene);
                renderScenes();
                if (engine === 'animate' && els.animateModel.value) {
                    dirStatus(`Shot ${i + 1}/${total}: animating the picture…`);
                    await animateCore(scene, (m) => dirStatus(`Shot ${i + 1}/${total}: ${m}`));
                    checkStop();
                }
                if (dir.sfx.checked && shot.sound && engine !== 'h3') {
                    dirStatus(`Shot ${i + 1}/${director.shots.length}: making the sound effect…`);
                    scene.sfx = { path: await makeAudio('sfx', shot.sound, Math.min(10, Math.max(3, sceneSeconds(scene) + 1)), (m) => dirStatus(`Shot ${i + 1}: ${m}`)), prompt: shot.sound, volume: 0.9 };
                    checkStop();
                }
                persist();
                renderScenes();
            }
            if (dir.titles.checked && director.title) {
                state.scenes.push({ id: newId(), kind: 'title', path: '', title: director.title.toUpperCase(), subtitle: 'Coming soon', duration: 3.5, color: '#0b0f1a', caption: '', motion: 'none' });
            }
            if (dir.music.checked && director.music) {
                dirStatus('Composing the soundtrack…');
                const seconds = totalSeconds() + 2;
                state.music = await makeAudio('music', director.music, Math.min(120, seconds), (m) => dirStatus(m));
                renderMusic();
                checkStop();
            }
            persist();
            renderScenes();
            dirStatus('Putting the movie together…');
            dirBusy(false);
            await render();
            dirStatus('Done. Your movie is ready on the right.');
        } catch (err) {
            persist();
            renderScenes();
            dirBusy(false);
            dirStatus(err.message === 'Stopped' ? 'Stopped. What was made so far is on the timeline.' : '');
            if (err.message !== 'Stopped') showError(err.message);
        } finally { dirBusy(false); }
    };
    dir.stop.onclick = () => { stopDirector = true; dirStatus('Stopping after the current step…'); window.localAI.cancelGeneration(); window.localAI.wan2gp.cancelGeneration(); };
    dir.shotSec.oninput = () => { dir.shotSecLabel.textContent = dir.shotSec.value; };
    dir.engine.onchange = () => { renderShots(); renderRefsBox(); };
    dir.addRef.onclick = () => openHistoryPicker('Choose a reference picture', async (list) => {
        for (const e of list) {
            if (director.refs.length >= 4) { showError('At most 4 reference pictures fit.'); break; }
            try { director.refs.push({ path: await historyFile(e), thumb: e.url, role: director.refs.length === 0 ? 'character' : 'place', name: '', notes: e.translatedPrompt || e.prompt || '', sheet: true }); } catch (err) { showError(err.message); }
        }
        renderRefs();
        renderShots();
    });
    if (!window.localAI.h3) { dir.engine.querySelector('option[value="h3"]').remove(); }
    try { dir.quality.value = localStorage.getItem('movie-shot-quality') || 'standard'; } catch { /* storage unavailable */ }
    dir.quality.onchange = () => { try { localStorage.setItem('movie-shot-quality', dir.quality.value); } catch { /* storage unavailable */ } };
    window.localAI.h3?.status().then((st) => {
        if (st?.upscaler) return;
        for (const value of ['sharp', 'best']) dir.quality.querySelector(`option[value="${value}"]`)?.remove();
        dir.quality.value = 'standard';
    }).catch(() => {});
    loadPictureModels();
    renderRefs();
    renderShots();
    Promise.all(director.refs.map(async (ref) => { ref.thumb = await api().url(ref.path); })).then(() => { director.refs = director.refs.filter((r) => r.thumb); renderRefs(); renderShots(); renderScenes(); });

    // ── Status banner ───────────────────────────────────────────
    function renderSetup() {
        const bad = !status?.ok;
        els.setup.classList.toggle('hidden', !bad);
        els.setup.textContent = bad ? `${status?.error || 'ffmpeg is missing'}. The movie maker uses the ffmpeg that comes with Wan2GP: install Wan2GP from Settings → Local Models, or put ffmpeg.exe in the local-ai/tools/ffmpeg folder.` : '';
        renderTotal();
    }

    // ── Boot ────────────────────────────────────────────────────
    async function takeSentItems() {
        const items = takeQueuedMovieItems();
        if (!items.length) return;
        const resolved = [];
        for (const item of items) {
            try {
                if (item.path) { resolved.push({ path: item.path, kind: item.kind, prompt: item.prompt }); continue; }
                const blob = await (await fetch(item.url)).blob();
                const saved = await api().importBytes({ name: `image.${(blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, type: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) });
                resolved.push({ path: saved.path, kind: 'image', prompt: item.prompt });
            } catch (err) { showError(err.message); }
        }
        await addMany(resolved);
    }
    window.addEventListener('movie:items', takeSentItems);
    window.addEventListener('beforeunload', () => { unsubscribe?.(); unsubscribeProgress?.(); });

    renderMusic();
    renderScenes();
    loadUpscaleModels().catch(() => {});
    // Scenes whose file was deleted since the last visit are dropped.
    (async () => {
        const kept = [];
        for (const scene of state.scenes) { if (scene.kind === 'title' || await api().url(scene.path)) kept.push(scene); }
        if (kept.length !== state.scenes.length) { state.scenes = kept; persist(); renderScenes(); }
    })();
    api().options().then((o) => {
        TRANSITIONS = o.transitions;
        TITLE_STYLES = o.titleStyles;
        CAPTION_STYLES = o.captionStyles;
        els.transition.innerHTML = TRANSITIONS.map(([v, l]) => option(v, l, v === state.transition)).join('');
        renderScenes();
    }).catch(() => {});
    api().status().then((s) => { status = s; renderSetup(); });
    loadAnimateModels();
    takeSentItems();
    return container;
}
