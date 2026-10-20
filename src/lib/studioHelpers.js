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
    const persistable = entries.filter(e => !String(e?.url || '').startsWith('data:')).slice(0, max);
    for (const list of [persistable, persistable.slice(0, 10), []]) {
        try {
            localStorage.setItem(storageKey, JSON.stringify(list));
            return;
        } catch { /* quota exceeded: retry with a shorter list */ }
    }
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
