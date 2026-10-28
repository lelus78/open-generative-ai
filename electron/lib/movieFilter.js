// Pure builder of the ffmpeg command that joins clips (videos and still pictures) into one movie.
// No electron / fs access here, so it can be unit-tested; movieMaker.js runs the result.
//
// project = {
//   clips: [{ path, kind: 'video'|'image', duration, trimStart?, trimEnd?, hasAudio?, motion?, caption? }],
//   width, height, fps, transition: 'none'|'fade'|'dissolve'|'wipeleft'|'slideleft'|…, transitionSeconds,
//   keepClipAudio, clipAudioVolume, music?: { path, volume, duration? }, fadeInOut, fontFile?, fonts?: { sans, bold, serif, serifBold, impact, mono },
//   preview?: true (small and fast, for checking the cut)
// clip.transitionIn: transition into this clip ('none' = cut, anything in TRANSITION_LIST; unset = the project's)
// }
// `duration` of a video is its usable length (probed); of an image, how long it stays on screen.

const { titleFilters, captionFilters, TITLE_STYLES, CAPTION_STYLES } = require('./movieText');
const { movieLoudnessFilter } = require('./audioLevel');

// ffmpeg xfade transitions offered to the user ('none' is a straight cut).
const TRANSITION_LIST = [
    ['none', 'Straight cut'], ['fade', 'Cross-fade'], ['fadeblack', 'Dip to black'], ['fadewhite', 'Flash to white'],
    ['wipeleft', 'Wipe left'], ['wiperight', 'Wipe right'], ['wipeup', 'Wipe up'], ['wipedown', 'Wipe down'],
    ['slideleft', 'Slide left'], ['slideright', 'Slide right'], ['slideup', 'Slide up'], ['slidedown', 'Slide down'],
    ['smoothleft', 'Soft push left'], ['smoothright', 'Soft push right'], ['smoothup', 'Soft push up'], ['smoothdown', 'Soft push down'],
    ['circleopen', 'Circle open'], ['circleclose', 'Circle close'], ['radial', 'Radial sweep'], ['rectcrop', 'Rectangle'],
    ['horzopen', 'Doors open (horizontal)'], ['vertopen', 'Doors open (vertical)'], ['horzclose', 'Doors close (horizontal)'], ['vertclose', 'Doors close (vertical)'],
    ['diagtl', 'Diagonal from top-left'], ['diagbr', 'Diagonal from bottom-right'], ['squeezeh', 'Squeeze (horizontal)'], ['squeezev', 'Squeeze (vertical)'],
    ['zoomin', 'Zoom in'], ['distance', 'Distance blur'], ['hlslice', 'Slices (horizontal)'], ['vuslice', 'Slices (vertical)'],
];
const TRANSITIONS = new Set(TRANSITION_LIST.map(([id]) => id));
const CUT_SECONDS = 0.04; // a cut inside a chain of transitions is a very short fade
const MOTIONS = new Set(['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right']);
const MIN_CLIP_SECONDS = 0.5;

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const round3 = (n) => Math.round(n * 1000) / 1000;

/** Escape a value for use inside an ffmpeg filter option (between single quotes). */
function escapeFilterText(text) {
    return String(text ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, '\u2019')
        .replace(/:/g, '\\:')
        .replace(/%/g, '\\%')
        .replace(/\r?\n/g, ' ');
}

/** Text to store in a caption file: drawtext expands % sequences, so a literal % is escaped. */
function captionFileText(text) {
    return String(text ?? '').replace(/\r?\n/g, ' ').trim().replace(/\\/g, '\\\\').replace(/%/g, '\\%');
}

/** "C:\Windows\Fonts\arial.ttf" → "C\:/Windows/Fonts/arial.ttf" (filter-safe path). */
function escapeFilterPath(p) {
    return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function clipDuration(clip) {
    const raw = num(clip.duration, clip.kind === 'image' ? 4 : clip.kind === 'title' ? 3 : 0);
    const start = Math.max(0, num(clip.trimStart, 0));
    const end = clip.trimEnd != null && num(clip.trimEnd, 0) > start ? num(clip.trimEnd, raw) : raw;
    if (clip.kind === 'image' || clip.kind === 'title') return Math.max(MIN_CLIP_SECONDS, raw);
    return Math.max(MIN_CLIP_SECONDS, Math.min(end, raw) - start);
}

function motionFilter(motion, frames, w, h, fps) {
    // zoompan works on a 2x picture so slow movements stay smooth; z is the zoom factor per frame.
    const total = Math.max(2, frames);
    const size = `${w}x${h}`;
    const center = "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'";
    switch (motion) {
        case 'zoom-out': return `zoompan=z='max(1.0,1.2-0.2*on/${total})':${center}:d=${total}:s=${size}:fps=${fps}`;
        case 'pan-left': return `zoompan=z=1.15:x='(iw-iw/zoom)*(1-on/${total})':y='ih/2-(ih/zoom/2)':d=${total}:s=${size}:fps=${fps}`;
        case 'pan-right': return `zoompan=z=1.15:x='(iw-iw/zoom)*on/${total}':y='ih/2-(ih/zoom/2)':d=${total}:s=${size}:fps=${fps}`;
        case 'none': return `zoompan=z=1:${center}:d=${total}:s=${size}:fps=${fps}`;
        default: return `zoompan=z='1.0+0.2*on/${total}':${center}:d=${total}:s=${size}:fps=${fps}`; // zoom-in
    }
}

function buildMovieArgs(project, outPath) {
    const clips = (project.clips || []).filter((c) => c && (c.path || c.kind === 'title'));
    if (!clips.length) throw new Error('Add at least one clip or picture to the movie.');

    const w = even(num(project.width, 1280));
    const h = even(num(project.height, 720));
    const fps = Math.min(60, Math.max(8, Math.round(num(project.fps, 24))));
    const transition = TRANSITIONS.has(project.transition) ? project.transition : 'none';
    const durations = clips.map(clipDuration);
    const wanted = Math.max(0.1, Math.min(num(project.transitionSeconds, 0.7), 3));
    // pair[i] = how clip i is joined to clip i-1. Never longer than half of either clip.
    const pair = clips.map((clip, i) => {
        if (i === 0) return { name: 'none', dur: 0 };
        const name = TRANSITIONS.has(clip.transitionIn) ? clip.transitionIn : transition;
        if (name === 'none') return { name: 'none', dur: 0 };
        return { name, dur: Math.max(0.1, Math.min(wanted, Math.min(durations[i - 1], durations[i]) / 2 - 0.05)) };
    });
    const useTransition = pair.some((x) => x.dur > 0) && clips.length > 1;
    const keepAudio = project.keepClipAudio !== false;
    const clipVolume = Math.max(0, Math.min(2, num(project.clipAudioVolume, 1)));

    const args = ['-y', '-hide_banner', '-nostats'];
    const filters = [];

    clips.forEach((clip, i) => {
        const dur = durations[i];
        if (clip.kind === 'title') {
            const color = /^#?[0-9a-fA-F]{6}$/.test(String(clip.color || '')) ? String(clip.color).replace('#', '0x') : '0x0b0f1a';
            args.push('-f', 'lavfi', '-t', String(round3(dur)), '-i', `color=c=${color}:s=${w}x${h}:r=${fps}`);
        } else if (clip.kind === 'image') {
            args.push('-i', clip.path);
        } else {
            const start = Math.max(0, num(clip.trimStart, 0));
            if (start > 0) args.push('-ss', String(round3(start)));
            args.push('-t', String(round3(dur)), '-i', clip.path);
        }
        const motion = MOTIONS.has(clip.motion) ? clip.motion : 'zoom-in';
        const frames = Math.round(dur * fps);
        const fit = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`;
        let video;
        if (clip.kind === 'title') {
            video = `[${i}:v]vignette=angle=PI/3.5,setsar=1,format=yuv420p`;
        } else if (clip.kind === 'image') {
            // Fill the frame (crop) at double size, then slowly move the camera across it.
            video = `[${i}:v]scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2},${motionFilter(motion, frames, w, h, fps)},setsar=1,format=yuv420p`;
        } else {
            video = `[${i}:v]${fit},setsar=1,fps=${fps},format=yuv420p`;
        }
        // Caption and title texts are read from files (see captionFileText), so no escaping of quotes,
        // colons or percent signs is needed inside the filter graph.
        for (const filter of [...captionFilters({ clip, dur, w, h, fonts: project.fonts, fontFile: project.fontFile }), ...titleFilters({ clip, dur, w, h, fonts: project.fonts, fontFile: project.fontFile })]) video += `,${filter}`;
        // Every clip is made exactly `dur` long so the transition maths below is exact.
        video += `,trim=duration=${round3(dur)},setpts=PTS-STARTPTS[v${i}]`;
        filters.push(video);

        const withAudio = keepAudio && clip.kind === 'video' && clip.hasAudio !== false;
        filters.push(withAudio
            ? `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${round3(clipVolume)},apad=whole_dur=${round3(dur)},atrim=duration=${round3(dur)},asetpts=PTS-STARTPTS[a${i}]`
            : `anullsrc=r=48000:cl=stereo,atrim=duration=${round3(dur)},asetpts=PTS-STARTPTS[a${i}]`);
    });

    // Join the clips.
    let vLabel = 'v0';
    let aLabel = 'a0';
    let total = durations[0];
    if (clips.length === 1) {
        // single clip: nothing to join
    } else if (useTransition) {
        for (let i = 1; i < clips.length; i++) {
            const name = pair[i].dur > 0 ? pair[i].name : 'fade';
            const d = pair[i].dur > 0 ? pair[i].dur : CUT_SECONDS;
            const offset = round3(total - d);
            filters.push(`[${vLabel}][v${i}]xfade=transition=${name}:duration=${round3(d)}:offset=${offset}[vx${i}]`);
            filters.push(`[${aLabel}][a${i}]acrossfade=d=${round3(d)}:c1=tri:c2=tri[ax${i}]`);
            vLabel = `vx${i}`;
            aLabel = `ax${i}`;
            total = round3(total + durations[i] - d);
        }
    } else {
        const inputs = clips.map((_, i) => `[v${i}][a${i}]`).join('');
        filters.push(`${inputs}concat=n=${clips.length}:v=1:a=1[vcat][acat]`);
        vLabel = 'vcat';
        aLabel = 'acat';
        total = round3(durations.reduce((a, b) => a + b, 0));
    }

    // Fade in / out of the whole movie.
    if (project.fadeInOut !== false && total > 2) {
        filters.push(`[${vLabel}]fade=t=in:st=0:d=0.5,fade=t=out:st=${round3(total - 0.7)}:d=0.7[vfinal]`);
        vLabel = 'vfinal';
    }

    // Sound effects: each one starts with its scene (plus an optional offset) and is mixed with the clips' own sound.
    const starts = [];
    {
        let at = 0;
        for (let i = 0; i < clips.length; i++) { starts.push(at); const next = pair[i + 1]; at += durations[i] - (useTransition && next ? (next.dur > 0 ? next.dur : CUT_SECONDS) : 0); }
    }
    const effects = clips.map((clip, i) => ({ clip, i })).filter(({ clip }) => clip.sfx?.path);
    let nextInput = clips.length;
    const mixed = [];
    for (const { clip, i } of effects) {
        args.push('-i', clip.sfx.path);
        const idx = nextInput++;
        const delay = Math.max(0, Math.round((starts[i] + num(clip.sfx.offset, 0)) * 1000));
        const gain = Math.max(0, Math.min(3, num(clip.sfx.volume, 0.8)));
        filters.push(`[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${round3(durations[i] + 1.5)},volume=${round3(gain)},afade=t=out:st=${round3(Math.max(0, durations[i] + 0.8))}:d=0.7,adelay=${delay}|${delay}[sfx${i}]`);
        mixed.push(`[sfx${i}]`);
    }
    if (mixed.length) {
        filters.push(`[${aLabel}]${mixed.join('')}amix=inputs=${mixed.length + 1}:duration=first:normalize=0,alimiter=limit=0.95[asfx]`);
        aLabel = 'asfx';
    }

    // Background music: looped to the movie length, faded out at the end, mixed under the clips' own sound.
    let audioMap = `[${aLabel}]`;
    if (project.music?.path) {
        const musicIndex = nextInput++;
        args.push('-stream_loop', '-1', '-i', project.music.path);
        const volume = Math.max(0, Math.min(2, num(project.music.volume, 0.5)));
        const fadeStart = round3(Math.max(0, total - 2));
        filters.push(`[${musicIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${round3(total)},volume=${round3(volume)},afade=t=in:st=0:d=1,afade=t=out:st=${fadeStart}:d=${round3(Math.min(2, total))}[music]`);
        filters.push(`[${aLabel}][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[amix]`);
        audioMap = '[amix]';
    } else if (project.fadeInOut !== false && total > 2) {
        filters.push(`[${aLabel}]afade=t=in:st=0:d=0.4,afade=t=out:st=${round3(total - 0.7)}:d=0.7[afinal]`);
        audioMap = '[afinal]';
    }
    // The finished mix at YouTube's loudness (−14 LUFS), so clips, music and effects from different models
    // do not come out too quiet or too loud. Previews skip it (they are only for checking the edit).
    if (project.loudness !== false && !project.preview) {
        filters.push(`${audioMap}${movieLoudnessFilter()}[aloud]`);
        audioMap = '[aloud]';
    }

    args.push(
        '-filter_complex', filters.join(';'),
        '-map', `[${vLabel}]`, '-map', audioMap,
        '-c:v', 'libx264', '-preset', project.preview ? 'ultrafast' : 'medium', '-crf', String(Math.max(14, Math.min(30, Math.round(num(project.crf, 20))))), '-pix_fmt', 'yuv420p',
        '-r', String(fps),
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-movflags', '+faststart',
        '-t', String(round3(total)),
        '-progress', 'pipe:1',
        outPath,
    );
    return { args, totalSeconds: total, width: w, height: h, fps };
}

/**
 * A title on a transparent background, as a clip with an alpha channel for other editors (DaVinci Resolve, Premiere…).
 * format 'mov' = ProRes 4444, 'webm' = VP9 with alpha. clip: { title, titleFile, subtitleFile?, titleStyle?, titleColor?, titleSize? }
 */
function buildTitleExportArgs({ clip, width = 1920, height = 1080, fps = 24, seconds = 4, format = 'mov', fonts, fontFile }, outPath) {
    const w = even(num(width, 1920));
    const h = even(num(height, 1080));
    const rate = Math.min(60, Math.max(8, Math.round(num(fps, 24))));
    const dur = Math.max(1, Math.min(30, num(seconds, 4)));
    const text = titleFilters({ clip: { ...clip, kind: 'title' }, dur, w, h, fonts, fontFile });
    if (!text.length) throw new Error('Write the title text first.');
    const graph = [`color=c=black@0.0:s=${w}x${h}:r=${rate}:d=${round3(dur)},format=rgba`, ...text, 'format=yuva444p'].join(',');
    const codec = format === 'webm'
        ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '0', '-crf', '18']
        : ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le'];
    return { args: ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', graph, '-t', String(round3(dur)), ...codec, '-an', outPath], width: w, height: h, seconds: dur };
}

/** Pulls ffmpeg's `-progress` key=value output into a 0..1 fraction. */
function parseProgress(chunk, totalSeconds) {
    let best = null;
    for (const m of String(chunk).matchAll(/out_time_(?:us|ms)=(\d+)/g)) best = Number(m[1]);
    if (best == null || !totalSeconds) return null;
    return Math.max(0, Math.min(1, best / 1e6 / totalSeconds));
}

/** Reads Duration / size / audio presence out of the text `ffmpeg -i file` prints. */
function parseProbe(text) {
    const s = String(text);
    const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
    const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
    const video = /Stream #[^\n]*Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(s);
    const fpsMatch = /(\d+(?:\.\d+)?)\s*fps/.exec(s);
    return {
        duration,
        width: video ? Number(video[1]) : 0,
        height: video ? Number(video[2]) : 0,
        fps: fpsMatch ? Number(fpsMatch[1]) : 0,
        hasVideo: /Stream #[^\n]*Video:/.test(s),
        hasAudio: /Stream #[^\n]*Audio:/.test(s),
    };
}

module.exports = { buildTitleExportArgs, TRANSITION_LIST, TITLE_STYLES, CAPTION_STYLES, captionFileText, buildMovieArgs, parseProgress, parseProbe, escapeFilterText, escapeFilterPath, TRANSITIONS, MOTIONS };
