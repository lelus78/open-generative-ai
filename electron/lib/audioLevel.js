// Audio levels. Every generated sound goes through a peak limiter (ceiling −1 dBFS) before it is kept, as
// NVAI-open does: Stable Audio can clip, and a clipped effect stays clipped in every movie that uses it.
// The movie's final mix is brought to −14 LUFS (YouTube's loudness) in movieFilter.js.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CEILING_DB = -1;
const MOVIE_LUFS = -14;

/** ffmpeg arguments that write `input` limited to the ceiling into `output` (same format, no make-up gain). */
function limiterArgs(input, output) {
    const limit = Math.pow(10, CEILING_DB / 20).toFixed(3);   // −1 dBFS → 0.891
    const ext = path.extname(output).toLowerCase();
    const codec = ext === '.wav' ? ['-c:a', 'pcm_s24le'] : ext === '.mp3' ? ['-c:a', 'libmp3lame', '-q:a', '2'] : [];
    return ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-af', `alimiter=limit=${limit}:level=false`, ...codec, output];
}

/** The loudness step for a movie's final mix (one pass; resampled back to 48 kHz after loudnorm). */
function movieLoudnessFilter() {
    return `loudnorm=I=${MOVIE_LUFS}:TP=${CEILING_DB - 0.5}:LRA=11,aresample=48000`;
}

/**
 * Limits a generated audio file in place. Never fails the generation: without ffmpeg, or if ffmpeg
 * fails, the file is kept as the model wrote it. Returns true when the file was limited.
 */
function limitFile(file, ffmpeg) {
    if (!ffmpeg || !file || !fs.existsSync(file)) return false;
    const tmp = path.join(path.dirname(file), `.limited-${process.pid}${path.extname(file)}`);
    const run = spawnSync(ffmpeg, limiterArgs(file, tmp), { windowsHide: true, timeout: 120000 });
    if (run.status !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
        try { fs.unlinkSync(tmp); } catch { /* nothing written */ }
        return false;
    }
    fs.renameSync(tmp, file);
    return true;
}

module.exports = { CEILING_DB, MOVIE_LUFS, limiterArgs, movieLoudnessFilter, limitFile };
