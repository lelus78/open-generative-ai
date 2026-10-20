import { t, tf } from './i18n.js';

// Behaviour shared by the studios (Image, Video, Cinema, Lip Sync): prompt history,
// copying a result to the clipboard, and paste / drag & drop of media files.

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
export function createTranslateToggle() {
    const api = window.localAI;
    if (!api?.getSettings) return null;
    const btn = document.createElement('button');
    btn.type = 'button';
    let enabled = true;
    const paint = () => {
        btn.className = `flex items-center gap-1.5 px-3 py-2 rounded-xl transition-all border text-xs font-bold whitespace-nowrap ${enabled
            ? 'bg-primary/20 border-primary/40 text-primary'
            : 'bg-white/5 border-white/5 text-white/50 hover:bg-white/10'}`;
        btn.textContent = enabled ? t('translate.on') : t('translate.off');
        btn.title = t('translate.help');
    };
    paint();
    api.getSettings().then(s => { enabled = !!s.translatePrompts; paint(); }).catch(() => {});
    btn.onclick = async (e) => {
        e.stopPropagation();
        enabled = !enabled;
        paint();
        try { await api.setSettings({ translatePrompts: enabled }); } catch { /* keep UI state */ }
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
