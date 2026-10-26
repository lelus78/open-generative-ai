// Text styles of the movie maker: big titles (title cards or over a scene) and captions.
// Pure module (no electron / fs): builds ffmpeg `drawtext` filters, unit-tested with the movie filter.

// `font` is a key of project.fonts (resolved to files by movieMaker.js); `scale` multiplies the base size.
const TITLE_STYLES = {
    classic: { label: 'Classic', font: 'bold', scale: 1, color: '#ffffff', border: 3, pos: 'center', anim: 'fade' },
    impact: { label: 'Impact', font: 'impact', scale: 1.3, color: '#ffffff', border: 5, pos: 'center', anim: 'fade' },
    gold: { label: 'Gold, serif', font: 'serifBold', scale: 0.95, color: '#e9c46a', border: 2, pos: 'center', anim: 'fade' },
    cinematic: { label: 'Cinematic, rising', font: 'serif', scale: 0.8, color: '#f4efe6', border: 0, pos: 'center', anim: 'slideup' },
    neon: { label: 'Neon', font: 'bold', scale: 1, color: '#35e9ff', border: 3, borderColor: '#00131a', pos: 'center', anim: 'fade' },
    fire: { label: 'Fire', font: 'impact', scale: 1.2, color: '#ff6a1a', border: 4, borderColor: '#2a0500', pos: 'center', anim: 'fade' },
    lowerthird: { label: 'Lower third bar', font: 'bold', scale: 0.5, color: '#ffffff', border: 0, box: '#000000@0.62', pos: 'lowerleft', anim: 'slideup' },
    banner: { label: 'Top banner', font: 'bold', scale: 0.6, color: '#ffffff', border: 0, box: '#b00020@0.88', pos: 'top', anim: 'fade' },
    tag: { label: 'Cinzel tag (low centre)', font: 'display', scale: 0.42, color: '#f4efe6', border: 0, pos: 'lowercenter', anim: 'fade' },
    cinzel: { label: 'Cinzel capitals', font: 'display', scale: 0.85, color: '#f4efe6', border: 0, pos: 'center', anim: 'fade', caps: true, shadow: { x: 0, y: 3, color: 'black@0.6' } },
    cinzelgold: { label: 'Cinzel gold', font: 'display', scale: 0.85, color: '#e9c46a', border: 0, pos: 'center', anim: 'fade', caps: true, shadow: { x: 0, y: 3, color: 'black@0.6' } },
    script: { label: 'Calligraphy', font: 'corsiva', scale: 1.6, color: '#f2e4c0', border: 0, pos: 'center', anim: 'slideup', shadow: { x: 2, y: 3, color: 'black@0.55' } },
    brush: { label: 'Brush script', font: 'brush', scale: 1.4, color: '#ffffff', border: 0, pos: 'center', anim: 'fade', shadow: { x: 3, y: 3, color: 'black@0.6' } },
    hand: { label: 'Handwritten', font: 'hand', scale: 1.35, color: '#ffffff', border: 0, pos: 'center', anim: 'fade', shadow: { x: 2, y: 2, color: 'black@0.6' } },
    medieval: { label: 'Medieval blackletter', font: 'blackletter', scale: 1.05, color: '#e8dcc0', border: 2, borderColor: '#2a1a08', pos: 'center', anim: 'fade' },
    papyrus: { label: 'Ancient scroll', font: 'papyrus', scale: 1, color: '#f1e2bf', border: 2, borderColor: '#3b2a14', pos: 'center', anim: 'fade' },
    horror: { label: 'Horror', font: 'chiller', scale: 1.5, color: '#c1121f', border: 3, borderColor: '#000000', pos: 'center', anim: 'fade' },
    stencil: { label: 'Stencil (military)', font: 'stencil', scale: 0.95, color: '#d9d9c8', border: 0, pos: 'center', anim: 'fade', caps: true, shadow: { x: 2, y: 2, color: 'black@0.6' } },
    copper: { label: 'Copperplate capitals', font: 'copper', scale: 0.85, color: '#ffffff', border: 0, pos: 'center', anim: 'fade', caps: true, shadow: { x: 0, y: 2, color: 'black@0.6' } },
    light: { label: 'Light and modern', font: 'light', scale: 1.05, color: '#ffffff', border: 0, pos: 'center', anim: 'fade', caps: true, shadow: { x: 0, y: 2, color: 'black@0.5' } },
    condensed: { label: 'Condensed capitals', font: 'condensed', scale: 1.15, color: '#ffffff', border: 0, pos: 'center', anim: 'fade', caps: true, shadow: { x: 0, y: 3, color: 'black@0.6' } },
    editorial: { label: 'Editorial italic', font: 'italic', scale: 1.05, color: '#f4efe6', border: 0, pos: 'center', anim: 'slideup', shadow: { x: 0, y: 2, color: 'black@0.5' } },
    retro: { label: 'Retro poster', font: 'showcard', scale: 1, color: '#ffd166', border: 0, pos: 'center', anim: 'fade', shadow: { x: 6, y: 6, color: '0xd62828' } },
    bauhaus: { label: 'Bauhaus pop', font: 'bauhaus', scale: 1.25, color: '#ffffff', border: 0, pos: 'center', anim: 'fade', shadow: { x: 5, y: 5, color: '0xff006e' } },
    pop: { label: 'Pop (orange shadow)', font: 'impact', scale: 1.25, color: '#ffffff', border: 0, pos: 'center', anim: 'fade', shadow: { x: 6, y: 6, color: '0xff7a00' } },
    pink: { label: 'Neon pink', font: 'bold', scale: 1, color: '#ff4fd8', border: 3, borderColor: '#2a002a', pos: 'center', anim: 'fade' },
    ice: { label: 'Ice', font: 'bold', scale: 1, color: '#bfe9ff', border: 3, borderColor: '#06283d', pos: 'center', anim: 'fade' },
    terminal: { label: 'Terminal', font: 'mono', scale: 0.7, color: '#9dff9d', border: 0, box: '#000000@0.55', pos: 'center', anim: 'fade' },
};

const CAPTION_STYLES = {
    subtitle: { label: 'Subtitle', font: 'sans', color: '#ffffff', border: 2, pos: 'bottom' },
    boxed: { label: 'Subtitle on a bar', font: 'sans', color: '#ffffff', border: 0, box: '#000000@0.6', pos: 'bottom' },
    yellow: { label: 'Yellow subtitle', font: 'bold', color: '#ffe14d', border: 3, pos: 'bottom' },
    top: { label: 'At the top', font: 'sans', color: '#ffffff', border: 2, pos: 'top' },
    cinema: { label: 'Cinema serif', font: 'serif', color: '#f4efe6', border: 2, pos: 'bottom' },
    cinzel: { label: 'Cinzel capitals', font: 'display', color: '#f2e4c0', border: 0, pos: 'lower', fade: true, caps: true },
    cinzelrules: { label: 'Cinzel with gold rules', font: 'display', color: '#f2e4c0', border: 0, pos: 'lower', fade: true, caps: true, rules: '#e9c46a' },
    typewriter: { label: 'Typewriter', font: 'mono', color: '#efe9d8', border: 0, pos: 'lower', fade: true, fit: 0.62, shadow: { x: 1, y: 2, color: 'black@0.6' } },
    handwritten: { label: 'Handwritten', font: 'hand', color: '#ffffff', border: 0, pos: 'lower', fade: true, fit: 0.5, sizeMul: 1.45, shadow: { x: 2, y: 2, color: 'black@0.6' } },
    calligraphy: { label: 'Calligraphy', font: 'corsiva', color: '#f2e4c0', border: 0, pos: 'lower', fade: true, fit: 0.42, sizeMul: 1.7, shadow: { x: 2, y: 2, color: 'black@0.6' } },
    italic: { label: 'Editorial italic', font: 'italic', color: '#f4efe6', border: 0, pos: 'lower', fade: true, fit: 0.5, shadow: { x: 0, y: 2, color: 'black@0.6' } },
    light: { label: 'Light and modern', font: 'light', color: '#ffffff', border: 0, pos: 'lower', fade: true, fit: 0.5, shadow: { x: 0, y: 2, color: 'black@0.6' } },
    goldserif: { label: 'Gold serif', font: 'serifBold', color: '#e9c46a', border: 0, pos: 'lower', fade: true, fit: 0.58, shadow: { x: 0, y: 3, color: 'black@0.6' } },
    medieval: { label: 'Medieval blackletter', font: 'blackletter', color: '#e8dcc0', border: 2, borderColor: '#2a1a08', pos: 'lower', fade: true, fit: 0.5 },
    scroll: { label: 'Ancient scroll', font: 'papyrus', color: '#f1e2bf', border: 2, borderColor: '#3b2a14', pos: 'lower', fade: true, fit: 0.5 },
    stencil: { label: 'Stencil capitals', font: 'stencil', color: '#d9d9c8', border: 0, pos: 'lower', fade: true, caps: true, fit: 0.72, shadow: { x: 2, y: 2, color: 'black@0.6' } },
    copper: { label: 'Copperplate capitals', font: 'copper', color: '#f2e4c0', border: 0, pos: 'lower', fade: true, caps: true, fit: 0.72, shadow: { x: 0, y: 2, color: 'black@0.6' } },
    condensed: { label: 'Condensed capitals', font: 'condensed', color: '#ffffff', border: 0, pos: 'lower', fade: true, caps: true, fit: 0.6, shadow: { x: 0, y: 3, color: 'black@0.6' } },
    boldcaps: { label: 'Bold capitals', font: 'impact', color: '#ffffff', border: 3, pos: 'lower', fade: true, caps: true, fit: 0.55 },
    label: { label: 'White label', font: 'bold', color: '#111111', box: '#ffffff@0.92', pos: 'lower', fade: true, fit: 0.6 },
    highlight: { label: 'Yellow highlight', font: 'bold', color: '#111111', box: '#ffd60a@0.95', pos: 'lower', fade: true, fit: 0.6 },
    redbar: { label: 'Red bar', font: 'bold', color: '#ffffff', box: '#b00020@0.9', pos: 'lower', fade: true, fit: 0.6 },
    neon: { label: 'Neon cyan', font: 'bold', color: '#35e9ff', border: 2, borderColor: '#00131a', pos: 'lower', fade: true, fit: 0.6 },
    elegant: { label: 'Elegant serif', font: 'serif', color: '#f4efe6', border: 0, pos: 'lower', fade: true },
};


// How the gallery sorts the styles into sections.
const STYLE_GROUPS = {
    title: {
        'Clean': ['classic', 'light', 'condensed', 'cinematic', 'lowerthird', 'banner', 'tag'],
        'Elegant': ['cinzel', 'cinzelgold', 'gold', 'script', 'editorial', 'copper'],
        'Bold and fun': ['impact', 'pop', 'retro', 'bauhaus', 'fire', 'neon', 'pink', 'ice'],
        'Fantasy and dark': ['medieval', 'papyrus', 'horror', 'stencil'],
        'Handmade and tech': ['hand', 'brush', 'terminal'],
    },
    caption: {
        'Classic subtitles': ['subtitle', 'boxed', 'yellow', 'top', 'cinema', 'light', 'boldcaps'],
        'Elegant': ['elegant', 'cinzel', 'cinzelrules', 'goldserif', 'italic', 'calligraphy', 'copper'],
        'Labels and bars': ['label', 'highlight', 'redbar', 'neon'],
        'Character': ['typewriter', 'handwritten', 'medieval', 'scroll', 'stencil', 'condensed'],
    },
};
const groupOf = (kind, id) => Object.entries(STYLE_GROUPS[kind]).find(([, ids]) => ids.includes(id))?.[0] || 'More';

const color = (value, fallback = '#ffffff') => String(value || fallback).replace('#', '0x');
const round3 = (n) => Math.round(n * 1000) / 1000;
const filterPath = (p) => String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

function fontFor(fonts, key, fallback) {
    return (fonts && (fonts[key] || fonts.bold || fonts.sans)) || fallback || null;
}

/** One drawtext filter. x / y / alpha / enable are ffmpeg expressions (already valid for use inside quotes). */
function drawText({ fontFile, textFile, size, fill, border = 0, borderColor = '#000000@0.85', box, shadow = true, shadowSpec, x, y, alpha, enable }) {
    if (!fontFile || !textFile) return '';
    const parts = [
        `drawtext=fontfile='${filterPath(fontFile)}'`, `textfile='${filterPath(textFile)}'`, `fontsize=${Math.max(12, Math.round(size))}`,
        `fontcolor=${color(fill)}`,
    ];
    if (border > 0) parts.push(`borderw=${border}`, `bordercolor=${color(borderColor)}`);
    if (shadowSpec && !box) parts.push(`shadowx=${Math.max(1, Math.round(shadowSpec.x * size / 60)) * Math.sign(shadowSpec.x || 0)}`, `shadowy=${Math.max(1, Math.round(shadowSpec.y * size / 60)) * Math.sign(shadowSpec.y || 0)}`, `shadowcolor=${color(shadowSpec.color, 'black@0.55')}`);
    else if (shadow && !box) parts.push('shadowx=2', 'shadowy=2', 'shadowcolor=black@0.55');
    if (box) parts.push('box=1', `boxcolor=${color(box)}`, `boxborderw=${Math.max(10, Math.round(size * 0.4))}`);
    parts.push(`x='${x}'`, `y='${y}'`);
    if (alpha) parts.push(`alpha='${alpha}'`);
    if (enable) parts.push(`enable='${enable}'`);
    return parts.join(':');
}

/** Fade in over 0.6 s and out over 0.5 s, for a clip of `dur` seconds. */
const fadeAlpha = (dur) => `min(1,max(0,(t-0.2)/0.6))*min(1,max(0,(${round3(dur)}-0.2-t)/0.5))`;

/**
 * Big title (+ optional smaller line) of a clip: [filters] to append to the clip's video chain.
 * clip: { kind, title, titleFile, subtitleFile, titleStyle, titleColor, titleSize }
 */
function titleFilters({ clip, dur, w, h, fonts, fontFile }) {
    if (!clip.titleFile) return [];
    const style = TITLE_STYLES[clip.titleStyle] || TITLE_STYLES.classic;
    const isCard = clip.kind === 'title';
    const file = fontFor(fonts, style.font, fontFile);
    const chars = Math.max(1, String(clip.title || '').length);
    const base = Math.round(h / (isCard ? 9 : 11) * style.scale * Math.max(0.4, Math.min(2, Number(clip.titleSize) || 1)));
    // Long titles shrink so they always fit inside the frame (average glyph is ~0.6 of the font size).
    const size = Math.max(20, Math.min(base, Math.floor((w * 0.86) / (chars * 0.6))));
    const fill = clip.titleColor || style.color;
    const sub = clip.subtitleFile ? Math.max(16, Math.round(size / 2.6)) : 0;
    const border = isCard ? Math.min(style.border, 2) : style.border;
    const alpha = fadeAlpha(dur);
    const rise = style.anim === 'slideup' ? `+40*pow(max(0,1-(t-0.15)/0.8),2)` : '';
    const left = Math.round(w * 0.06);
    const place = {
        center: { x: '(w-text_w)/2', y: (extra) => `(h-text_h)/2-${Math.round(sub ? size * 0.45 : 0)}${extra}` },
        top: { x: '(w-text_w)/2', y: (extra) => `h*0.09${extra}` },
        lowerleft: { x: String(left), y: (extra) => `h*0.74${extra}` },
        lowercenter: { x: '(w-text_w)/2', y: (extra) => `h*0.79${extra}` },
    }[style.pos] || null;
    const filters = [drawText({ fontFile: file, textFile: clip.titleFile, size, fill, border, borderColor: style.borderColor, box: style.box, shadowSpec: style.shadow, x: place.x, y: place.y(rise), alpha })];
    if (clip.subtitleFile) {
        const subFont = fontFor(fonts, 'sans', fontFile);
        const lowerLeft = style.pos === 'lowerleft';
        filters.push(drawText({
            fontFile: subFont, textFile: clip.subtitleFile, size: sub, fill: '#ffffff@0.92', border: isCard ? 0 : 2,
            box: lowerLeft ? style.box : undefined, shadow: !isCard,
            x: lowerLeft ? String(left) : place.x,
            y: style.pos === 'center' ? `(h-text_h)/2+${Math.round(size * 0.75)}${rise}` : style.pos === 'top' ? `h*0.09+${Math.round(size * 1.5)}${rise}` : `h*0.74+${Math.round(size * 1.6)}${rise}`,
            alpha,
        }));
    }
    return filters.filter(Boolean);
}

/** The caption of a clip (small text at the bottom or top, a little after the clip starts). */
function captionFilters({ clip, dur, w, h, fonts, fontFile }) {
    if (!clip.captionFile) return [];
    const style = CAPTION_STYLES[clip.captionStyle] || CAPTION_STYLES.subtitle;
    let size = Math.max(18, Math.round(h / (style.fade ? 22 : 20) * (style.sizeMul || 1)));
    if (style.caps) size = Math.min(size, Math.round(h / 30)); // one calm size for every line, so the rules never reach the next text
    const glyph = style.fit || (style.caps ? 0.66 : 0);
    if (glyph && w) size = Math.max(18, Math.min(size, Math.floor((w * 0.86) / (Math.max(1, String(clip.caption || '').length) * glyph)))); // wide letters: shrink to fit
    const y = style.pos === 'top' ? `h*0.07` : style.pos === 'lower' ? `h*0.7` : `h-text_h-${Math.round(h / 14)}`;
    // A "fade" caption eases in and out instead of popping on and off.
    const fontPath = fontFor(fonts, style.font, fontFile);
    const filters = [drawText({
        fontFile: fontPath, textFile: clip.captionFile, size, fill: style.color, border: style.border, borderColor: style.borderColor, box: style.box, shadowSpec: style.shadow,
        x: '(w-text_w)/2', y, ...(style.fade ? { alpha: fadeAlpha(dur) } : { enable: `between(t,0.3,${round3(Math.max(0.5, dur - 0.3))})` }),
    })];
    // Thin rules above and below the line: short lines of dashes in the same font, fading with the text.
    if (style.rules && fontPath) {
        const rule = (offset) => `drawtext=fontfile='${filterPath(fontPath)}':text='—————':fontsize=${Math.round(size * 0.7)}:fontcolor=${color(style.rules)}:x='(w-text_w)/2':y='${y}${offset}':alpha='${fadeAlpha(dur)}'`;
        filters.unshift(rule(`-${Math.round(size * 1.45)}`));
        filters.push(rule(`+${Math.round(size * 1.6)}`));
    }
    return filters.filter(Boolean);
}

/** The text of a clip as the style wants it written (some styles set everything in capitals). */
function styledText(styleKey, kind, text) {
    const style = (kind === 'caption' ? CAPTION_STYLES : TITLE_STYLES)[styleKey];
    return style?.caps ? String(text ?? '').toUpperCase() : String(text ?? '');
}

module.exports = { TITLE_STYLES, CAPTION_STYLES, STYLE_GROUPS, groupOf, titleFilters, captionFilters, drawText, styledText };
