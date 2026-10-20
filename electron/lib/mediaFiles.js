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

/** A sensible default file name for "Save as": keep the URL's own name when it has one. */
function defaultFileName(srcURL, mediaType, now = Date.now()) {
    const fallbackExt = { image: '.png', video: '.mp4', audio: '.mp3' }[mediaType] || '';
    try {
        const url = String(srcURL || '');
        if (url.startsWith('data:')) {
            const mime = /^data:([^;,]*)/.exec(url)?.[1];
            return `${mediaType || 'file'}-${now}${MIME_EXTENSIONS[mime] || fallbackExt}`;
        }
        const name = path.basename(decodeURIComponent(new URL(url).pathname));
        if (name && path.extname(name)) return name;
    } catch { /* not a parseable URL */ }
    return `${mediaType || 'file'}-${now}${fallbackExt}`;
}

module.exports = { LABELS, labelsFor, decodeDataUrl, defaultFileName };
