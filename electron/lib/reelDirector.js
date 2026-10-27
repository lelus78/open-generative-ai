// The Reel preset: from the photos of one creation to a vertical reel that opens on the most striking photo,
// tells the rest in the order the photos were given (raw → work → finished) and ends on a call to action
// that fits the goal. Two cuts: Discovery (9-12 s, quick, for new followers) and Showcase (15-25 s, slower,
// more room for the work). Used by the Movie tab and by the movie_reel MCP tool.
//
// The photos are only moved by the camera (zoom, pan): pixels stay the original ones, so real faces stay
// exactly as they are. Photos marked as having faces are listed in `protected_faces`, so an assistant knows
// not to send them to a video or edit model.
const fs = require('fs');
const path = require('path');

const VARIANTS = {
    discovery: { hook: 1.5, end: 1.9, mid: [0.95, 1.5], target: 10.5, maxPhotos: 7, transitionSeconds: 0.25, hookMotion: 'zoom-out', defaultGoal: 'followers' },
    showcase: { hook: 2.4, end: 2.5, mid: [1.9, 3.2], target: 19, maxPhotos: 8, transitionSeconds: 0.5, hookMotion: 'zoom-in', defaultGoal: 'showcase' },
};
// pace stretches the target length: a sale gives the product a little more time, a follower reel is quicker
const GOALS = { followers: { pace: 0.92 }, showcase: { pace: 1 }, sell: { pace: 1.08 } };
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

/** Sharpness, colourfulness and contrast of a small RGBA/BGRA bitmap (the order of red and blue does not change them much). */
function measurePixels(data, width, height, { channels = 4, order = 'bgra' } = {}) {
    const r = order === 'bgra' ? 2 : 0;
    const b = order === 'bgra' ? 0 : 2;
    const n = width * height;
    if (!n || data.length < n * channels) throw new Error('The picture could not be read.');
    const luma = new Float32Array(n);
    let rgSum = 0, ybSum = 0, rgSq = 0, ybSq = 0, lSum = 0, lSq = 0;
    for (let i = 0; i < n; i++) {
        const o = i * channels;
        const R = data[o + r], G = data[o + 1], B = data[o + b];
        const l = 0.299 * R + 0.587 * G + 0.114 * B;
        luma[i] = l;
        lSum += l; lSq += l * l;
        const rg = R - G, yb = 0.5 * (R + G) - B;
        rgSum += rg; ybSum += yb; rgSq += rg * rg; ybSq += yb * yb;
    }
    const std = (sum, sq) => Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2));
    // Hasler & Süsstrunk colourfulness
    const colorfulness = Math.hypot(std(rgSum, rgSq), std(ybSum, ybSq)) + 0.3 * Math.hypot(rgSum / n, ybSum / n);
    // variance of the Laplacian: high for a sharp, detailed photo, low for a blurred one
    let lapSum = 0, lapSq = 0, count = 0;
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const v = luma[i - 1] + luma[i + 1] + luma[i - width] + luma[i + width] - 4 * luma[i];
            lapSum += v; lapSq += v * v; count++;
        }
    }
    const sharpness = count ? lapSq / count - (lapSum / count) ** 2 : 0;
    return { sharpness, colorfulness, contrast: std(lSum, lSq) };
}

/** Each measure becomes a rank between 0 and 1 among the photos, then one score: sharp first, then colour, then contrast. */
function rankScores(items) {
    const rank = (key) => {
        const sorted = [...items].sort((a, b) => a[key] - b[key]);
        return (item) => (items.length > 1 ? sorted.indexOf(item) / (items.length - 1) : 1);
    };
    const sharp = rank('sharpness'), colour = rank('colorfulness'), contrast = rank('contrast');
    return items.map((item) => ({ ...item, score: Math.round((0.45 * sharp(item) + 0.35 * colour(item) + 0.2 * contrast(item)) * 1000) / 1000 }));
}

/** An array of picture paths, or a folder whose pictures are taken in name order. */
function listPhotos(input) {
    if (Array.isArray(input)) return input.map(String);
    const folder = String(input || '');
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('Give the photos as a list of picture paths or the path of a folder of pictures.');
    return fs.readdirSync(folder).filter((f) => IMAGE_RE.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((f) => path.join(folder, f));
}

/** Score photos on this PC. `decode(path)` → { data, width, height } (Electron's nativeImage in the app). */
function analysePhotos(paths, { decode }) {
    const measured = paths.map((p) => {
        try { const { data, width, height } = decode(p); return { path: p, ...measurePixels(data, width, height) }; }
        catch { return { path: p, sharpness: 0, colorfulness: 0, contrast: 0 }; }
    });
    return rankScores(measured);
}

function endCard(goal, texts) {
    if (goal === 'sell') return { title: texts.call_to_action || 'Want one?', subtitle: texts.link || texts.handle || 'Link in bio' };
    if (goal === 'followers') return { title: texts.call_to_action || 'Follow for more', subtitle: texts.handle || '' };
    return { title: texts.title || texts.call_to_action || '', subtitle: texts.subtitle || texts.handle || '' };
}

/**
 * photos: [{ path, score?, faces? }] in story order. texts: { hook, title, subtitle, call_to_action, handle, link, captions[] }.
 * Returns the arguments of movie_render (format, fps, transition, scenes…) plus what was decided.
 */
function planReel({ photos, variant = 'discovery', goal, texts = {} }) {
    const v = VARIANTS[variant];
    if (!v) throw new Error('variant must be discovery or showcase.');
    const g = goal || v.defaultGoal;
    if (!GOALS[g]) throw new Error('goal must be followers, showcase or sell.');
    const list = (photos || []).map((p, index) => ({ ...p, index, score: Number.isFinite(p.score) ? p.score : 0 }));
    if (list.length < 3) throw new Error('A reel needs at least 3 photos.');

    const byScore = (a, b) => b.score - a.score || a.index - b.index;
    const opener = [...list].sort(byScore)[0];
    const rest = list.filter((p) => p !== opener);
    const story = [...rest].sort(byScore).slice(0, v.maxPhotos).sort((a, b) => a.index - b.index);
    // the last picture: the best one left out of the story, or back to the opener (the reel loops nicely)
    const endPhoto = [...rest].sort(byScore).find((p) => !story.includes(p)) || opener;

    const fade = v.transitionSeconds;
    const n = story.length;
    const target = v.target * GOALS[g].pace;
    const mid = Math.min(v.mid[1], Math.max(v.mid[0], (target - v.hook - v.end + fade * (n + 1)) / n));
    const round = (x) => Math.round(x * 100) / 100;
    const captions = Array.isArray(texts.captions) ? texts.captions : [];
    const end = endCard(g, texts);

    const scenes = [
        { type: 'image', path: opener.path, duration: v.hook, motion: v.hookMotion, ...(texts.hook ? { title: texts.hook } : {}) },
        ...story.map((p, k) => ({ type: 'image', path: p.path, duration: round(mid), motion: k % 2 ? 'zoom-out' : 'zoom-in', ...(captions[k] ? { caption: captions[k] } : {}) })),
        { type: 'image', path: endPhoto.path, duration: v.end, motion: 'zoom-in', ...(end.title ? { title: end.title } : {}), ...(end.subtitle ? { subtitle: end.subtitle } : {}) },
    ];
    const seconds = round(scenes.reduce((sum, s) => sum + s.duration, 0) - fade * (scenes.length - 1));
    return {
        name: [`reel ${variant}`, texts.title || texts.hook].filter(Boolean).join(' - '),
        variant, goal: g, seconds,
        format: '1080x1920', fps: 30, transition: 'fade', transition_seconds: fade,
        scenes,
        opener: opener.path,
        left_out: rest.filter((p) => !story.includes(p) && p !== endPhoto).map((p) => p.path),
        protected_faces: list.filter((p) => p.faces).map((p) => p.path),
    };
}

module.exports = { VARIANTS, GOALS, measurePixels, rankScores, listPhotos, analysePhotos, planReel };
