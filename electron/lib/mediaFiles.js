// Pure helpers of the context menu (no electron import, so they can be unit-tested).
const path = require('path');

const LABELS = {
    en: {
        undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select all',
        copyImage: 'Copy image', saveImage: 'Save image as…', saveVideo: 'Save video as…', saveAudio: 'Save audio as…',
        copyAddress: 'Copy media address', openLink: 'Open link in browser', copyLink: 'Copy link address',
        addToDictionary: 'Add to dictionary', inspect: 'Inspect element', noSuggestions: 'No spelling suggestions',
    },
    it: {
        undo: 'Annulla', redo: 'Ripeti', cut: 'Taglia', copy: 'Copia', paste: 'Incolla', selectAll: 'Seleziona tutto',
        copyImage: 'Copia immagine', saveImage: 'Salva immagine con nome…', saveVideo: 'Salva video con nome…', saveAudio: 'Salva audio con nome…',
        copyAddress: 'Copia indirizzo del contenuto', openLink: 'Apri link nel browser', copyLink: 'Copia indirizzo del link',
        addToDictionary: 'Aggiungi al dizionario', inspect: 'Ispeziona elemento', noSuggestions: 'Nessun suggerimento ortografico',
    },
    zh: {
        undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选',
        copyImage: '复制图片', saveImage: '图片另存为…', saveVideo: '视频另存为…', saveAudio: '音频另存为…',
        copyAddress: '复制媒体地址', openLink: '在浏览器中打开链接', copyLink: '复制链接地址',
        addToDictionary: '添加到词典', inspect: '检查元素', noSuggestions: '没有拼写建议',
    },
};

function labelsFor(locale) {
    const lang = String(locale || 'en').toLowerCase().slice(0, 2);
    return LABELS[lang] || LABELS.en;
}

const MIME_EXTENSIONS = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
};

/** Decode a data: URL into { mime, buffer }; null when it is not a base64/percent-encoded data URL. */
function decodeDataUrl(url) {
    const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(url || ''));
    if (!match) return null;
    const [, mime, isBase64, payload] = match;
    return { mime: mime || 'application/octet-stream', buffer: isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload)) };
}

// Names a result gets inside its run folder; the folder says what it is ("2026-10-27 10-49-34 - reel discovery - …").
const GENERIC_NAMES = /^(movie|preview|image|output|out|result)\.\w+$/i;

/**
 * A sensible default file name for "Save as": the URL's own name when it says something, else the name of its
 * folder, else the date and the kind ("2026-10-27 10-49-34 - image.png"), so saved files sort by time.
 */
function defaultFileName(srcURL, mediaType, now = Date.now()) {
    const fallbackExt = { image: '.png', video: '.mp4', audio: '.mp3' }[mediaType] || '';
    const d = new Date(now);
    const pad = (n) => String(n).padStart(2, '0');
    const dated = (ext) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())} - ${mediaType || 'file'}${ext}`;
    try {
        const url = String(srcURL || '');
        if (url.startsWith('data:')) {
            const mime = /^data:([^;,]*)/.exec(url)?.[1];
            return dated(MIME_EXTENSIONS[mime] || fallbackExt);
        }
        const file = decodeURIComponent(new URL(url).pathname);
        const name = path.basename(file);
        const folder = path.basename(path.dirname(file));
        if (name && path.extname(name) && GENERIC_NAMES.test(name) && /^\d{4}-\d\d-\d\d /.test(folder)) return `${folder}${path.extname(name)}`;
        if (name && path.extname(name)) return name;
    } catch { /* not a parseable URL */ }
    return dated(fallbackExt);
}

module.exports = { LABELS, labelsFor, decodeDataUrl, defaultFileName };
