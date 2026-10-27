import { t, tf } from './i18n.js';

// Behaviour shared by the studios (Image, Video, Cinema, Lip Sync): prompt history,
// copying a result to the clipboard, and paste / drag & drop of media files.

/**
 * The name a downloaded result gets: date first (so saved files sort by time), then what it shows,
 * e.g. "2026-10-27 10-49-34 - a fox in the snow.png". The browser fixes the extension to the real type.
 */
export function resultFileName(entry, kind, ext) {
    const value = entry?.timestamp;
    const parsed = typeof value === 'number' ? value : Date.parse(value);
    const fromId = Number(entry?.id);
    const d = new Date(Number.isFinite(parsed) ? parsed : fromId > 1e12 ? fromId : Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    let what = String(entry?.prompt || entry?.settings?.prompt || '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (what.length > 60) what = what.slice(0, 60).replace(/\s+\S*$/, '');
    return `${stamp} - ${what.replace(/[. ]+$/, '') || kind}${ext}`;
}

/**
 * ArrowUp / ArrowDown in the prompt box cycle through the last 10 prompts (kept in localStorage).
 * ArrowUp only acts when the box is empty or the caret is at the very start, so editing a
 * multi-line prompt still works. Returns `remember(text)` to call when a generation starts.
 */
export function attachPromptHistory(textarea, storageKey) {
    const load = () => {
        try { return JSON.parse(localStorage.getItem(storageKey)) || []; } catch { return []; }
    };
    let index = -1;
    let draft = '';

    textarea.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        const list = load();
        if (!list.length) return;
        const atStart = textarea.selectionStart === 0 && textarea.selectionEnd === 0;
        const atEnd = textarea.selectionStart === textarea.value.length;
        let next = index;
        if (e.key === 'ArrowUp' && (index >= 0 || atStart || !textarea.value)) {
            if (index === -1) draft = textarea.value;
            next = Math.min(index + 1, list.length - 1);
        } else if (e.key === 'ArrowDown' && index >= 0 && atEnd) {
            next = index - 1;
        } else {
            return;
        }
        e.preventDefault();
        index = next;
        textarea.value = next === -1 ? draft : list[next];
        textarea.dispatchEvent(new Event('input'));
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });

    return {
        remember(text) {
            if (!text) return;
            const list = [text, ...load().filter(p => p !== text)].slice(0, 10);
            try { localStorage.setItem(storageKey, JSON.stringify(list)); } catch { /* storage unavailable */ }
            index = -1;
        },
    };
}

// Clipboard only accepts PNG reliably, so re-encode anything else through a canvas.
async function imageToPngBlob(src) {
    const blob = await (await fetch(src)).blob();
    if (blob.type === 'image/png') return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNG encoding failed')), 'image/png'));
}

export async function copyImageToClipboard(src) {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': imageToPngBlob(src) })]);
}

/**
 * Wire a "Copy" button (and Ctrl/Cmd+C while the result is on screen) to copy an image.
 * @param {{ button: HTMLButtonElement, getSrc: () => string, isVisible: () => boolean,
 *           container: HTMLElement, label: string, doneLabel: string }} opts
 */
export function attachImageCopy({ button, getSrc, isVisible, container, label, doneLabel }) {
    const copy = async () => {
        const src = getSrc();
        if (!src) return;
        try {
            await copyImageToClipboard(src);
            button.textContent = doneLabel;
        } catch (err) {
            console.error('[studio] Copy failed:', err);
            button.textContent = '✕';
        }
        setTimeout(() => { button.textContent = label; }, 1500);
    };
    button.onclick = copy;

    const onKey = (e) => {
        if (!container.isConnected) { window.removeEventListener('keydown', onKey); return; }
        if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'c') return;
        if (!isVisible() || String(window.getSelection())) return;
        e.preventDefault();
        copy();
    };
    window.addEventListener('keydown', onKey);
}

/** Hand files to an existing <input type="file"> as if the user had chosen them in the dialog. */
export function feedFileInput(input, files) {
    const transfer = new DataTransfer();
    files.forEach(f => transfer.items.add(f));
    input.files = transfer.files;
    input.onchange?.({ target: input });
}

const filesOfType = (dt, prefix) => Array.from(dt?.files || []).filter(f => f.type.startsWith(prefix));

/**
 * Paste (Ctrl+V in the prompt box) and drag & drop of media. Each handler is optional and
 * receives the files of its type: { image(files), video(files), audio(files) }.
 */
export function attachMediaDrop({ container, textarea, image, video, audio }) {
    const dispatch = (dt) => {
        const images = filesOfType(dt, 'image/');
        const videos = filesOfType(dt, 'video/');
        const audios = filesOfType(dt, 'audio/');
        let handled = false;
        if (images.length && image) { image(images); handled = true; }
        if (videos.length && video) { video(videos); handled = true; }
        if (audios.length && audio) { audio(audios); handled = true; }
        return handled;
    };

    // Plain text paste is left alone: only intercept when files were pasted.
    textarea.addEventListener('paste', (e) => {
        if (dispatch(e.clipboardData)) e.preventDefault();
    });
    container.addEventListener('dragover', (e) => {
        if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
    });
    container.addEventListener('drop', (e) => {
        if (dispatch(e.dataTransfer)) e.preventDefault();
    });
}

/**
 * Persist a studio's generation history without ever throwing. Results of local models are
 * inline `data:` images of several MB each, which would blow the localStorage quota after a few
 * generations, so those stay in memory for the session and only regular URLs are saved.
 */
export function saveHistory(storageKey, entries, max) {
    // Inline results that live in a file on disk are saved without the image; hydrateHistory() reads it back.
    const persistable = entries
        .filter(e => !String(e?.url || '').startsWith('data:') || e.path)
        .map(e => (String(e.url || '').startsWith('data:') ? { ...e, url: '' } : e))
        .slice(0, max);
    for (const list of [persistable, persistable.slice(0, 10), []]) {
        try {
            localStorage.setItem(storageKey, JSON.stringify(list));
            return;
        } catch { /* quota exceeded: retry with a shorter list */ }
    }
}

/**
 * After a restart: entries saved without their image get it back from the file on disk.
 * Entries whose file is gone are removed. Calls `onChange` when something was filled in or dropped.
 */
export async function hydrateHistory(entries, storageKey, max, onChange) {
    const pending = entries.filter(e => !e.url && e.path);
    if (!pending.length) return;
    for (const entry of pending) {
        let url = null;
        try { url = await window.localAI?.wan2gp?.readOutput(entry.path); } catch { /* unreadable */ }
        if (url) entry.url = url;
        else { const i = entries.indexOf(entry); if (i >= 0) entries.splice(i, 1); }
    }
    saveHistory(storageKey, entries, max);
    onChange?.();
}

export const TRASH_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>';

/**
 * Delete the file behind a history entry. Local Wan2GP results carry the `path` of the file on
 * disk; cloud results and inline sd.cpp images have none, so only the history entry goes away.
 */
export async function removeGenerationFile(entry) {
    if (entry?.path && window.localAI?.wan2gp?.deleteOutput) {
        await window.localAI.wan2gp.deleteOutput(entry.path);
    }
}

/** Empty a history: delete the files of local results, clear the array and persist the empty list. */
export async function clearHistoryEntries(entries, storageKey, max) {
    for (const entry of [...entries]) {
        try { await removeGenerationFile(entry); } catch { /* already gone */ }
    }
    entries.length = 0;
    saveHistory(storageKey, entries, max);
}

let closePopup = null;

/**
 * Small HTML context menu at the pointer. `items`: { label, onClick, danger?, disabled? } or 'separator'.
 * Calling preventDefault() on the event keeps the native menu from also appearing.
 */
export function showPopupMenu(event, items) {
    event.preventDefault();
    event.stopPropagation();
    closePopup?.();

    const menu = document.createElement('div');
    menu.className = 'fixed z-[300] w-52 py-1 rounded-xl bg-[#1a1a1a] border border-white/10 shadow-2xl text-xs animate-fade-in';
    items.forEach((item) => {
        if (item === 'separator') {
            const line = document.createElement('div');
            line.className = 'my-1 h-px bg-white/10';
            menu.appendChild(line);
            return;
        }
        const row = document.createElement('button');
        row.type = 'button';
        row.disabled = !!item.disabled;
        row.className = `w-full text-left px-3 py-2 font-bold transition-colors ${item.disabled ? 'text-white/30 cursor-not-allowed' : item.danger ? 'text-red-400 hover:bg-red-500/10' : 'text-white hover:bg-white/10'}`;
        row.textContent = item.label.replace(/^[^\p{L}]+/u, ''); // drop leading arrows/symbols used on the buttons
        row.onclick = () => { close(); item.onClick?.(); };
        menu.appendChild(row);
    });
    document.body.appendChild(menu);

    // Keep the menu inside the window
    const x = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8);
    const y = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8);
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;

    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const onOutside = (e) => { if (!menu.contains(e.target)) close(); };
    function close() {
        menu.remove();
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('mousedown', onOutside, true);
        window.removeEventListener('blur', close);
        window.removeEventListener('resize', close);
        closePopup = null;
    }
    closePopup = close;
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onOutside, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
}

/**
 * Right-click on a result (the image/video shown full screen): offers the same actions as its
 * buttons. Labels come from the buttons themselves, minus any leading arrow/symbol.
 */
export function attachResultMenu(element, buttons) {
    element.addEventListener('contextmenu', (e) => {
        const items = buttons.filter(Boolean).map((button) => ({
            label: button.textContent.replace(/^[^\p{L}]+/u, '').trim(),
            danger: /text-red-/.test(button.className),
            onClick: () => button.click(),
        }));
        showPopupMenu(e, items);
    });
}

export const formatBytes = (bytes) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

/**
 * Text for a progress event of a local generation ({ status, step, totalSteps, downloadedBytes, message }).
 * Wan2GP downloads the weights of a model the first time it is used and reports it as status
 * 'downloading', which must not be shown as a generation percentage.
 */
export function localProgressLabel({ status, step, totalSteps, downloadedBytes, message }) {
    if (status === 'downloading') return tf('video.localDownloading', formatBytes(downloadedBytes || 0));
    if (status === 'loading') return t('video.localLoading');
    if (status === 'encoding') return t('video.localEncoding');
    if (status === 'generating' && totalSteps) return tf('video.localStep', step, totalSteps);
    if (status === 'decoding') return t('video.localDecoding');
    if (status === 'saving' || status === 'done') return t('video.localSaving');
    return message || t('video.localStarting');
}

/**
 * Small button that switches local prompt translation on/off (same setting as Settings → Local Models).
 * Returns null outside Electron, where nothing is translated locally.
 */
export function createTranslateToggle({ compact = false } = {}) {
    return settingToggle('translatePrompts', 'translate', compact ? 'compact' : 'normal');
}

/** Same kind of button for the automatic enhancer: short prompts are rewritten in detailed English before generating. */
export function createEnhanceToggle({ compact = false } = {}) {
    return settingToggle('enhancePrompts', 'enhanceAuto', compact ? 'compact' : 'normal');
}

/**
 * The Translate / Enhance switches as a small row to put right under a prompt field. `enhance: false` for
 * studios whose prompt is only translated (Cinema composes its own look, H3 keeps the reference names).
 * Returns null outside Electron.
 */
export function createPromptSwitches({ enhance = true, className = '' } = {}) {
    const translate = settingToggle('translatePrompts', 'translate', 'mini');
    if (!translate) return null;
    const row = document.createElement('div');
    row.className = `flex flex-wrap items-center gap-1.5 ${className}`;
    row.appendChild(translate);
    if (enhance) row.appendChild(settingToggle('enhancePrompts', 'enhanceAuto', 'mini'));
    return row;
}

/**
 * With ✨ Enhance on, shows the rewritten prompt in a card right after `after` before a local generation starts:
 * it starts by itself after a 4 s countdown; clicking or typing in the text stops it so it can be edited.
 * Resolves to { prompt, ready } (ready: the text was reviewed, the backend must not rewrite it again),
 * to { prompt: text, ready: false } when nothing is rewritten, or to null when the user cancels.
 * The accepted text replaces what was typed in `field`, so it can be reused or edited; generating it again
 * sends it as it is, without a second rewrite.
 */
const acceptedPrompts = new Set();
export async function reviewEnhancedPrompt({ text, kind, after, field, seconds = 4 }) {
    const api = window.localAI;
    const plain = { prompt: text, ready: false };
    if (acceptedPrompts.has(String(text || '').trim())) return { prompt: text, ready: true };
    if (!api?.previewPrompt || !after?.parentNode || !String(text || '').trim()) return plain;
    try { if (!(await api.getSettings()).enhancePrompts) return plain; } catch { return plain; }

    document.querySelectorAll('.enhance-review').forEach(el => el.remove());
    const card = document.createElement('div');
    card.className = 'enhance-review flex flex-col gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3 mx-2 mt-2';
    card.innerHTML = `
        <div class="flex items-center justify-between gap-2">
            <span class="er-title text-[11px] font-bold text-primary">${t('enhanceReview.working')}</span>
            <button type="button" class="er-cancel text-[11px] text-white/50 hover:text-white">${t('enhanceReview.cancel')}</button>
        </div>
        <textarea spellcheck="false" class="er-text hidden w-full min-h-[70px] rounded-lg bg-black/30 border border-white/10 p-2 text-xs text-white leading-relaxed outline-none focus:border-primary/60 resize-y"></textarea>
        <div class="er-actions hidden flex items-center gap-2">
            <button type="button" class="er-go px-3 py-1.5 rounded-lg bg-primary text-black text-xs font-bold"></button>
            <button type="button" class="er-edit px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/80 text-xs font-bold">${t('enhanceReview.edit')}</button>
        </div>`;
    after.after(card);
    const $ = (s) => card.querySelector(s);

    return new Promise((resolve) => {
        let timer = null;
        let done = false;
        const finish = (value) => {
            if (done) return;
            done = true;
            clearInterval(timer);
            card.remove();
            resolve(value);
        };
        $('.er-cancel').onclick = () => finish(null);

        api.previewPrompt(text, kind).then((better) => {
            if (done) return;
            if (!better) { finish(plain); return; }
            const area = $('.er-text');
            area.value = better;
            area.classList.remove('hidden');
            $('.er-actions').classList.remove('hidden');
            $('.er-title').textContent = t('enhanceReview.ready');
            const go = $('.er-go');
            const start = () => {
                const final = area.value.trim() || text;
                acceptedPrompts.add(final);
                if (field) {
                    field.value = final;
                    field.dispatchEvent(new Event('input', { bubbles: true }));   // auto-height, prompt history
                }
                finish({ prompt: final, ready: true });
            };
            let left = seconds;
            const paint = () => { go.textContent = timer ? t('enhanceReview.goIn').replace('{n}', left) : t('enhanceReview.go'); };
            const stop = () => { clearInterval(timer); timer = null; paint(); $('.er-edit').classList.add('hidden'); };
            timer = setInterval(() => { left -= 1; if (left <= 0) start(); else paint(); }, 1000);
            paint();
            go.onclick = start;
            $('.er-edit').onclick = () => { stop(); area.focus(); };
            area.addEventListener('focus', stop);
            area.addEventListener('input', stop);
        }).catch(() => finish(plain));
    });
}

const TOGGLE_SIZES = { normal: 'px-3 py-2 rounded-xl text-xs', compact: 'px-3 py-1.5 rounded-md text-xs', mini: 'px-2.5 py-1 rounded-lg text-[11px]' };

function settingToggle(setting, labels, size) {
    const api = window.localAI;
    if (!api?.getSettings) return null;
    const btn = document.createElement('button');
    btn.type = 'button';
    let enabled = setting === 'translatePrompts';
    const paint = () => {
        btn.className = `flex items-center gap-1.5 ${TOGGLE_SIZES[size] || TOGGLE_SIZES.normal} transition-all border font-bold whitespace-nowrap ${enabled
            ? 'bg-primary/20 border-primary/40 text-primary'
            : 'bg-white/5 border-white/5 text-white/50 hover:bg-white/10'}`;
        btn.textContent = enabled ? t(`${labels}.on`) : t(`${labels}.off`);
        btn.title = t(`${labels}.help`);
    };
    paint();
    api.getSettings().then(s => { enabled = !!s[setting]; paint(); }).catch(() => {});
    // the same switches in Settings → Local Models keep this button in step
    window.addEventListener('local-settings:changed', (e) => { if (setting in (e.detail || {})) { enabled = !!e.detail[setting]; paint(); } });
    btn.onclick = async (e) => {
        e.stopPropagation();
        enabled = !enabled;
        paint();
        try { await api.setSettings({ [setting]: enabled }); } catch { /* keep UI state */ }
        window.dispatchEvent(new CustomEvent('local-settings:changed', { detail: { [setting]: enabled } }));
    };
    return btn;
}

/**
 * Click an image to open it full size: mouse wheel zooms, drag pans, double-click toggles 1x/2.5x,
 * Esc or a click on the dark area closes.
 */
export function attachImageZoom(img) {
    img.style.cursor = 'zoom-in';
    img.addEventListener('click', () => {
        if (!img.src) return;
        const overlay = document.createElement('div');
        overlay.className = 'fixed inset-0 z-[10000] bg-black/90 flex items-center justify-center overflow-hidden select-none';
        const big = document.createElement('img');
        big.src = img.src;
        big.draggable = false;
        big.className = 'max-w-[95vw] max-h-[95vh] object-contain';
        big.style.cursor = 'grab';
        overlay.appendChild(big);

        let scale = 1; let x = 0; let y = 0;
        const apply = () => { big.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; };
        const reset = () => { scale = 1; x = 0; y = 0; apply(); };
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
        const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
        document.addEventListener('keydown', onKey, true);

        overlay.addEventListener('wheel', (e) => {
            e.preventDefault();
            const next = Math.min(12, Math.max(1, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
            scale = next;
            if (scale === 1) { x = 0; y = 0; }
            apply();
        }, { passive: false });
        let drag = null;
        big.addEventListener('mousedown', (e) => { e.preventDefault(); drag = { sx: e.clientX - x, sy: e.clientY - y, moved: false }; big.style.cursor = 'grabbing'; });
        window.addEventListener('mousemove', function move(e) {
            if (!overlay.isConnected) { window.removeEventListener('mousemove', move); return; }
            if (!drag) return;
            drag.moved = true; x = e.clientX - drag.sx; y = e.clientY - drag.sy; apply();
        });
        window.addEventListener('mouseup', () => { drag = null; big.style.cursor = 'grab'; });
        big.addEventListener('dblclick', () => { if (scale > 1) reset(); else { scale = 2.5; apply(); } });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.body.appendChild(overlay);
    });
}
