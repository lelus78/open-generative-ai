// Text styles of the movie maker: big titles (title cards or over a scene) and captions.
// Pure module (no electron / fs): builds ffmpeg `drawtext` filters, unit-tested with the movie filter.

// `font` is a key of project.fonts (resolved to files by movieMaker.js); `scale` multiplies the base size.
const TITLE_STYLES = {
    classic: { label: 'Classic', font: 'bold', scale: 1, color: '#ffffff', border: 3, pos: 'center', anim: 'fade' },
    impact: { label: 'Impact (big, bold)', font: 'impact', scale: 1.3, color: '#ffffff', border: 5, pos: 'center', anim: 'fade' },
    gold: { label: 'Gold, serif', font: 'serifBold', scale: 0.95, color: '#e9c46a', border: 2, pos: 'center', anim: 'fade' },
    cinematic: { label: 'Cinematic, rising', font: 'serif', scale: 0.8, color: '#f4efe6', border: 0, pos: 'center', anim: 'slideup' },
    neon: { label: 'Neon', font: 'bold', scale: 1, color: '#35e9ff', border: 3, borderColor: '#00131a', pos: 'center', anim: 'fade' },
    fire: { label: 'Fire', font: 'impact', scale: 1.2, color: '#ff6a1a', border: 4, borderColor: '#2a0500', pos: 'center', anim: 'fade' },
    lowerthird: { label: 'Lower third (name bar)', font: 'bold', scale: 0.5, color: '#ffffff', border: 0, box: '#000000@0.62', pos: 'lowerleft', anim: 'slideup' },
    banner: { label: 'Top banner', font: 'bold', scale: 0.6, color: '#ffffff', border: 0, box: '#b00020@0.88', pos: 'top', anim: 'fade' },
    terminal: { label: 'Terminal', font: 'mono', scale: 0.7, color: '#9dff9d', border: 0, box: '#000000@0.55', pos: 'center', anim: 'fade' },
};

const CAPTION_STYLES = {
    subtitle: { label: 'Subtitle', font: 'sans', color: '#ffffff', border: 2, pos: 'bottom' },
    boxed: { label: 'Subtitle on a dark bar', font: 'sans', color: '#ffffff', border: 0, box: '#000000@0.6', pos: 'bottom' },
    yellow: { label: 'Yellow subtitle', font: 'bold', color: '#ffe14d', border: 3, pos: 'bottom' },
    top: { label: 'At the top', font: 'sans', color: '#ffffff', border: 2, pos: 'top' },
    cinema: { label: 'Cinema (spaced, serif)', font: 'serif', color: '#f4efe6', border: 2, pos: 'bottom' },
};

const color = (value, fallback = '#ffffff') => String(value || fallback).replace('#', '0x');
const round3 = (n) => Math.round(n * 1000) / 1000;
const filterPath = (p) => String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

function fontFor(fonts, key, fallback) {
    return (fonts && (fonts[key] || fonts.bold || fonts.sans)) || fallback || null;
}

/** One drawtext filter. x / y / alpha / enable are ffmpeg expressions (already valid for use inside quotes). */
function drawText({ fontFile, textFile, size, fill, border = 0, borderColor = '#000000@0.85', box, shadow = true, x, y, alpha, enable }) {
    if (!fontFile || !textFile) return '';
    const parts = [
        `drawtext=fontfile='${filterPath(fontFile)}'`, `textfile='${filterPath(textFile)}'`, `fontsize=${Math.max(12, Math.round(size))}`,
        `fontcolor=${color(fill)}`,
    ];
    if (border > 0) parts.push(`borderw=${border}`, `bordercolor=${color(borderColor)}`);
    if (shadow && !box) parts.push('shadowx=2', 'shadowy=2', 'shadowcolor=black@0.55');
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
    }[style.pos] || null;
    const filters = [drawText({ fontFile: file, textFile: clip.titleFile, size, fill, border, borderColor: style.borderColor, box: style.box, x: place.x, y: place.y(rise), alpha })];
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
function captionFilters({ clip, dur, h, fonts, fontFile }) {
    if (!clip.captionFile) return [];
    const style = CAPTION_STYLES[clip.captionStyle] || CAPTION_STYLES.subtitle;
    const size = Math.max(18, Math.round(h / 20));
    const y = style.pos === 'top' ? `h*0.07` : `h-text_h-${Math.round(h / 14)}`;
    return [drawText({
        fontFile: fontFor(fonts, style.font, fontFile), textFile: clip.captionFile, size, fill: style.color, border: style.border, box: style.box,
        x: '(w-text_w)/2', y, enable: `between(t,0.3,${round3(Math.max(0.5, dur - 0.3))})`,
    })].filter(Boolean);
}

module.exports = { TITLE_STYLES, CAPTION_STYLES, titleFilters, captionFilters, drawText };
