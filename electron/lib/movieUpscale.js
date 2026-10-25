// Final upscale of a finished movie.
//   fast — ffmpeg: Lanczos scaling + a light sharpen (seconds, no GPU).
//   ai   — the user's ComfyUI with an upscale model (4x-UltraSharp, Real-ESRGAN…): the movie is cut into 2-second pieces
//          (a whole movie at 4x does not fit in memory), every piece is upscaled and the pieces are joined again with the
//          original sound.
// No electron import: the caller passes ffmpeg's path and the ComfyUI helpers, so the pure parts can be unit-tested.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TARGET_HEIGHTS = { '1080p': 1080, '1440p': 1440, '4k': 2160 };
const SEGMENT_SECONDS = 2;
// The AI model gets pictures no taller than this: the clips of the local video models are ~416p anyway, and the cost grows with the pixels.
const FEED_HEIGHT = 576;

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Output size for a source of srcW x srcH scaled to the named target (same shape, never smaller than the source). */
function targetSize(srcW, srcH, target) {
    const height = TARGET_HEIGHTS[target];
    if (!height) throw new Error(`Unknown target size: ${target}`);
    const portrait = srcH > srcW;
    // The target names the short side for landscape (1080p = 1080 high) and for portrait movies too (1080 wide).
    const short = Math.max(height, Math.min(srcW, srcH));
    const scale = short / Math.min(srcW, srcH);
    return { width: even(srcW * scale), height: even(srcH * scale), portrait };
}

/** The ComfyUI graph that upscales one video piece: LoadVideo → upscale model → resize → CreateVideo → SaveVideo. */
function buildUpscaleGraph({ file, model, width, height, prefix }) {
    return {
        1: { class_type: 'LoadVideo', inputs: { file } },
        2: { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
        3: { class_type: 'UpscaleModelLoader', inputs: { model_name: model } },
        4: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['3', 0], image: ['2', 0] } },
        5: { class_type: 'ImageScale', inputs: { image: ['4', 0], upscale_method: 'lanczos', width, height, crop: 'disabled' } },
        6: { class_type: 'CreateVideo', inputs: { images: ['5', 0], fps: ['2', 2] } },
        7: { class_type: 'SaveVideo', inputs: { video: ['6', 0], filename_prefix: prefix, format: 'auto', codec: 'auto' } },
    };
}

function runFfmpeg(bin, args, { onStdout, isCancelled, setChild } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { windowsHide: true });
        setChild?.(child);
        let tail = '';
        child.stdout.on('data', (d) => onStdout?.(d.toString()));
        child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-3000); });
        child.on('error', (err) => reject(new Error(`Could not start ffmpeg: ${err.message}`)));
        child.on('close', (code) => {
            if (isCancelled?.()) return reject(new Error('Upscale cancelled'));
            if (code === 0) return resolve();
            reject(new Error(`ffmpeg failed (code ${code}).\n${tail.split(String.fromCharCode(10)).slice(-5).join(String.fromCharCode(10))}`));
        });
    });
}

async function probeSize(bin, file) {
    const { spawnSync } = require('child_process');
    const res = spawnSync(bin, ['-hide_banner', '-i', file], { encoding: 'utf8', windowsHide: true });
    const m = /Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(`${res.stderr || ''}`);
    const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(`${res.stderr || ''}`);
    if (!m) throw new Error('Cannot read the movie size.');
    return { width: Number(m[1]), height: Number(m[2]), seconds: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0 };
}

/** Fast path: Lanczos + a light sharpen, sound copied. */
async function upscaleFast({ bin, input, output, size, send, isCancelled, setChild }) {
    send({ type: 'status', message: 'Upscaling (fast)…', progress: 0 });
    const src = await probeSize(bin, input);
    await runFfmpeg(bin, [
        '-y', '-hide_banner', '-nostats', '-i', input,
        '-vf', `scale=${size.width}:${size.height}:flags=lanczos,unsharp=5:5:0.8:3:3:0.3`,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart',
        '-progress', 'pipe:1', output,
    ], {
        isCancelled, setChild,
        onStdout: (text) => {
            const m = [...text.matchAll(/out_time_us=(\d+)/g)].pop();
            if (m && src.seconds) send({ type: 'progress', progress: Math.min(0.99, Number(m[1]) / 1e6 / src.seconds) });
        },
    });
}

/** AI path through ComfyUI. comfy = { ensureServer, comfyJson, upload, view }; all calls are made on the running server. */
async function upscaleAi({ bin, input, output, size, model, strength = 0.4, comfy, workDir, send, isCancelled, setChild, interrupt }) {
    send({ type: 'status', message: 'Starting ComfyUI…', progress: 0 });
    const port = await comfy.ensureServer();
    if (isCancelled()) throw new Error('Upscale cancelled');

    // 1. cut into pieces that start on a key frame, without sound
    send({ type: 'status', message: 'Cutting the movie into pieces…', progress: 0 });
    const pieces = path.join(workDir, 'pieces');
    fs.mkdirSync(pieces, { recursive: true });
    await runFfmpeg(bin, [
        '-y', '-hide_banner', '-nostats', '-i', input, '-an',
        '-vf', `scale=-2:'min(ih,${FEED_HEIGHT})'`,
        '-c:v', 'libx264', '-crf', '10', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
        '-f', 'segment', '-segment_time', String(SEGMENT_SECONDS), '-reset_timestamps', '1', path.join(pieces, 'piece-%03d.mp4'),
    ], { isCancelled, setChild });
    const files = fs.readdirSync(pieces).filter((f) => /^piece-\d+[.]mp4$/.test(f)).sort();
    if (!files.length) throw new Error('Could not cut the movie.');

    // 2. every piece through the upscale model
    const done = path.join(workDir, 'upscaled');
    fs.mkdirSync(done, { recursive: true });
    const stamp = Date.now();
    const startedAt = Date.now();
    for (const [index, name] of files.entries()) {
        if (isCancelled()) throw new Error('Upscale cancelled');
        send({ type: 'status', message: `Upscaling piece ${index + 1} of ${files.length} with ${model}${eta(startedAt, index, files.length)}…`, progress: index / files.length });
        const uploaded = await comfy.upload(`oga-up-${stamp}-${name}`, fs.readFileSync(path.join(pieces, name)));
        const queued = await comfy.comfyJson(port, '/prompt', { prompt: buildUpscaleGraph({ file: uploaded, model, width: size.width, height: size.height, prefix: `video/OGA_upscale_${stamp}` }), client_id: `upscale-${stamp}` });
        const promptId = queued.prompt_id;
        interrupt.current = () => comfy.comfyJson(port, '/interrupt', { prompt_id: promptId }).catch(() => {});
        let entry = null;
        for (;;) {
            if (isCancelled()) { await interrupt.current(); throw new Error('Upscale cancelled'); }
            await new Promise((r) => setTimeout(r, 800));
            const history = (await comfy.comfyJson(port, `/history/${promptId}`))[promptId];
            if (!history) continue;
            if (history.status?.status_str === 'error') {
                const message = (history.status.messages || []).find((m) => m[0] === 'execution_error')?.[1];
                throw new Error(`ComfyUI could not upscale a piece: ${message?.exception_message || 'execution error'}`);
            }
            entry = history.outputs?.['7']?.images?.[0];
            if (entry) break;
            if (history.status?.completed) throw new Error('ComfyUI finished but returned no video.');
        }
        fs.writeFileSync(path.join(done, name), await comfy.view(port, entry));
    }
    interrupt.current = null;

    // 3. join the pieces, put the original sound back
    send({ type: 'status', message: 'Joining the pieces…', progress: 0.97 });
    const list = path.join(workDir, 'list.txt');
    fs.writeFileSync(list, files.map((f) => `file '${path.join(done, f).replace(/\\/g, '/')}'`).join(String.fromCharCode(10)));
    const mix = blendFilter(size, strength);
    await runFfmpeg(bin, [
        '-y', '-hide_banner', '-nostats', '-f', 'concat', '-safe', '0', '-i', list, '-i', input,
        '-filter_complex', mix.graph, '-map', mix.label, '-map', '1:a:0?', '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', output,
    ], { isCancelled, setChild });
}

/**
 * Final video filter of the AI path: the AI picture mixed with a plain Lanczos enlargement of the original.
 * AI models smooth faces and skin (anime models most of all); mixing in some of the original keeps their detail.
 * strength = share of the AI picture, 0..1. At 1 the AI result is used as it is.
 */
function blendFilter(size, strength) {
    const s = Math.max(0, Math.min(1, Number.isFinite(Number(strength)) ? Number(strength) : 0.4));
    if (s >= 0.99) return { graph: '[0:v]null[v]', label: '[v]' };
    const ai = Math.round(s * 100) / 100;
    return {
        graph: `[1:v]scale=${size.width}:${size.height}:flags=lanczos[orig];[0:v][orig]blend=all_expr='A*${ai}+B*${Math.round((1 - s) * 100) / 100}',unsharp=5:5:0.5:3:3:0.0[v]`,
        label: '[v]',
    };
}

/** " (about 12 min left)" once at least one piece is done, else "". */
function eta(startedAt, done, total) {
    if (done < 1) return '';
    const left = ((Date.now() - startedAt) / done) * (total - done) / 1000;
    return left >= 90 ? ` (about ${Math.round(left / 60)} min left)` : ` (about ${Math.max(5, Math.round(left / 5) * 5)} s left)`;
}

module.exports = { FEED_HEIGHT, eta, blendFilter, TARGET_HEIGHTS, SEGMENT_SECONDS, targetSize, buildUpscaleGraph, upscaleFast, upscaleAi, probeSize };
