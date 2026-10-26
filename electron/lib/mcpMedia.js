// The MCP tools for everything beyond still images: video, lip sync, music and sound effects, MiniMax H3 shots and the
// whole movie maker (storyboard, render, upscale, titles, picture editing). With mcpTools.js this lets an assistant use
// the app completely. Everything that touches an engine comes in through `deps`, so the contracts are unit-tested
// without Electron.
//
// Long work (a video, an H3 shot, a movie) runs as a job: the tool waits a little and, when the job is not finished,
// answers with its id; `job_status` waits for it. A single GPU lane keeps two engines from running at once.
const fs = require('fs');
const path = require('path');
const { pickModel } = require('./mcpTools');

const text = (value) => ({ type: 'text', text: value });
const MAX_WAIT = 55;
const ASPECTS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4 };
const QUALITY = {
    standard: { megapixels: 0.3, upscale: false },
    sharp: { megapixels: 0.3, upscale: true, upscaleMegapixels: 0.6 },
    best: { megapixels: 0.4, upscale: true, upscaleMegapixels: 0.8 },
};

// ─── Jobs ───────────────────────────────────────────────────────────
function createJobs({ now = () => Date.now(), keep = 60 } = {}) {
    const jobs = new Map();
    const lanes = new Map();
    let counter = 0;

    function start({ name, lane = 'gpu', run, cancel }) {
        const job = { id: `job-${++counter}`, name, lane, state: 'queued', createdAt: now(), startedAt: null, finishedAt: null, result: null, error: null, cancelRequested: false, cancel };
        jobs.set(job.id, job);
        for (const id of [...jobs.keys()].slice(0, Math.max(0, jobs.size - keep))) { if (jobs.get(id).finishedAt) jobs.delete(id); }
        const previous = lanes.get(lane) || Promise.resolve();
        job.done = previous.catch(() => {}).then(async () => {
            if (job.cancelRequested) { job.state = 'cancelled'; job.finishedAt = now(); return; }
            job.state = 'running';
            job.startedAt = now();
            try {
                job.result = await run(job);
                job.state = 'done';
            } catch (err) {
                job.error = String(err?.message || err);
                job.state = job.cancelRequested || /cancel/i.test(job.error) ? 'cancelled' : 'error';
            }
            job.finishedAt = now();
        });
        lanes.set(lane, job.done);
        return job;
    }

    const get = (id) => jobs.get(String(id));
    const list = () => [...jobs.values()].reverse();
    async function wait(job, seconds) {
        const ms = Math.min(MAX_WAIT, Math.max(0, Number(seconds) || 0)) * 1000;
        if (!ms || job.finishedAt) return job;
        let timer;
        await Promise.race([job.done, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
        clearTimeout(timer);
        return job;
    }
    function cancel(job) {
        if (job.finishedAt) return false;
        job.cancelRequested = true;
        if (job.state === 'running') { try { job.cancel?.(); } catch { /* the engine may be idle already */ } }
        return true;
    }
    return { start, get, list, wait, cancel };
}

function describeJob(job, now = Date.now()) {
    const seconds = Math.round(((job.finishedAt || now) - (job.startedAt || job.createdAt)) / 1000);
    if (job.state === 'done') return `${job.id} (${job.name}) is done after ${seconds} s.\n${job.result?.summary || ''}`.trim();
    if (job.state === 'error') return `${job.id} (${job.name}) failed: ${job.error}`;
    if (job.state === 'cancelled') return `${job.id} (${job.name}) was cancelled.`;
    if (job.state === 'queued') return `${job.id} (${job.name}) is waiting for the engine to be free.`;
    return `${job.id} (${job.name}) is still running (${seconds} s so far). Ask again with job_status ${job.id} and wait_seconds.`;
}

// ─── Pure helpers ───────────────────────────────────────────────────
/** "720x1280" (or width and height) → { width, height }, even numbers between 240 and 4096. */
function parseFormat(args = {}) {
    let width = Number(args.width);
    let height = Number(args.height);
    if (args.format) {
        const m = /^(\d{3,4})\s*x\s*(\d{3,4})$/i.exec(String(args.format).trim());
        if (!m) throw new Error('format must look like 720x1280 (width x height).');
        width = Number(m[1]);
        height = Number(m[2]);
    }
    if (!width && !height) { width = 1280; height = 720; }
    const ok = (v) => Number.isFinite(v) && v >= 240 && v <= 4096;
    if (!ok(width) || !ok(height)) throw new Error('The movie size must be between 240 and 4096 pixels on each side.');
    return { width: Math.round(width / 2) * 2, height: Math.round(height / 2) * 2 };
}

const idsOf = (list) => new Set((list || []).map((item) => (Array.isArray(item) ? item[0] : item)));

/**
 * What the assistant describes (scenes with plain field names) → the project the movie maker renders.
 * `options` = { transitions, titleStyles, captionStyles }, `fileOk(path)` checks that a file exists.
 */
function buildMovieProject(args = {}, { options, fileOk = (f) => path.isAbsolute(f) && fs.existsSync(f) } = {}) {
    const scenes = Array.isArray(args.scenes) ? args.scenes : [];
    if (!scenes.length) throw new Error('scenes must list at least one scene.');
    const transitions = idsOf(options?.transitions);
    const titleStyles = idsOf(options?.titleStyles);
    const captionStyles = idsOf(options?.captionStyles);
    const check = (set, value, what, field) => {
        if (value && set.size && !set.has(value)) throw new Error(`${field} "${value}" is not a known ${what}. Use movie_options to see the valid ones.`);
        return value || undefined;
    };
    if (args.transition) check(transitions, args.transition, 'transition', 'transition');
    const size = parseFormat(args);

    const clips = scenes.map((scene, i) => {
        const where = `scenes[${i}]`;
        const type = scene.type || (scene.path && /\.(png|jpe?g|webp)$/i.test(scene.path) ? 'image' : scene.path ? 'video' : 'title');
        if (!['video', 'image', 'title'].includes(type)) throw new Error(`${where}.type must be video, image or title.`);
        const clip = {
            kind: type,
            caption: scene.caption || undefined,
            captionStyle: check(captionStyles, scene.caption_style, 'caption style', `${where}.caption_style`),
            title: scene.title || undefined,
            subtitle: scene.subtitle || undefined,
            titleStyle: check(titleStyles, scene.title_style, 'title style', `${where}.title_style`),
            titleColor: scene.title_color || undefined,
            transitionIn: check(transitions, scene.transition_in, 'transition', `${where}.transition_in`),
        };
        if (type === 'title') {
            if (!clip.title && !clip.subtitle) throw new Error(`${where} is a title card: give it a title.`);
            return { ...clip, path: '', duration: Number(scene.duration) > 0 ? Number(scene.duration) : 3, color: scene.color || '#0b0f1a', motion: 'none' };
        }
        if (!scene.path || !fileOk(scene.path)) throw new Error(`${where}.path must be the absolute path of an existing file.`);
        if (scene.sfx_path && !fileOk(scene.sfx_path)) throw new Error(`${where}.sfx_path must be the absolute path of an existing audio file.`);
        const sfx = scene.sfx_path ? { path: scene.sfx_path, volume: Number(scene.sfx_volume) > 0 ? Number(scene.sfx_volume) : 0.9 } : undefined;
        if (type === 'image') return { ...clip, path: scene.path, duration: Number(scene.duration) > 0 ? Number(scene.duration) : 4, motion: scene.motion || 'zoom-in', sfx };
        return { ...clip, path: scene.path, trimEnd: Number(scene.trim_seconds) > 0 ? Number(scene.trim_seconds) : undefined, sfx };
    });

    if (args.music_path && !fileOk(args.music_path)) throw new Error('music_path must be the absolute path of an existing audio file.');
    return {
        ...size,
        fps: [24, 25, 30, 60].includes(Number(args.fps)) ? Number(args.fps) : 24,
        transition: args.transition || 'fade',
        transitionSeconds: Number(args.transition_seconds) >= 0 ? Number(args.transition_seconds) : 0.7,
        keepClipAudio: args.keep_clip_audio !== false,
        fadeInOut: args.fade_in_out !== false,
        quality: args.quality === 'preview' ? 'preview' : 'final',
        music: args.music_path ? { path: args.music_path, volume: Number(args.music_volume) >= 0 ? Number(args.music_volume) : 0.4 } : undefined,
        clips,
    };
}

/** The same scenes as the Movie tab keeps them, so an assistant can hand a project to the interface. */
function buildInterfaceProject(project, durations = {}) {
    return {
        scenes: project.clips.map((clip, i) => ({
            id: `mcp-${Date.now().toString(36)}-${i}`,
            kind: clip.kind,
            path: clip.path,
            duration: clip.kind === 'video' ? Number(durations[clip.path]) || 5 : clip.duration,
            motion: clip.motion || 'zoom-in',
            caption: clip.caption || '', trimEnd: clip.trimEnd || 0, label: clip.kind === 'title' ? '' : path.basename(clip.path || ''),
            title: clip.title || '', subtitle: clip.subtitle || '', color: clip.color, transitionIn: clip.transitionIn,
            titleStyle: clip.titleStyle, titleColor: clip.titleColor, captionStyle: clip.captionStyle,
            sfx: clip.sfx,
        })),
        format: `${project.width}x${project.height}`, fps: project.fps, transition: project.transition, transitionSeconds: project.transitionSeconds,
        keepAudio: project.keepClipAudio, fadeInOut: project.fadeInOut,
        music: project.music?.path || null, musicVolume: project.music?.volume ?? 0.4,
    };
}

/** H3 shot: friendly arguments → the parameters of the H3 generator. */
function buildH3Params(args = {}, { fileOk = (f) => path.isAbsolute(f) && fs.existsSync(f) } = {}) {
    if (!String(args.story || '').trim()) throw new Error('story is required: say what happens in the shot (English works best).');
    const refs = Array.isArray(args.references) ? args.references : [];
    if (!refs.length) throw new Error('references must list 1 to 4 pictures (objects, places or people the shot must keep).');
    if (refs.length > 4) throw new Error('At most 4 reference pictures fit.');
    refs.forEach((ref, i) => { if (!ref?.path || !fileOk(ref.path)) throw new Error(`references[${i}].path must be the absolute path of an existing picture.`); });
    const quality = QUALITY[args.quality] || QUALITY.standard;
    const ratio = ASPECTS[args.aspect_ratio] || ASPECTS['16:9'];
    const roles = ['character', 'place', 'object'];
    const named = refs.map((ref, i) => ({ role: roles.includes(ref.role) ? ref.role : (i === 0 ? 'character' : 'object'), name: String(ref.name || '').trim() || `Reference${i + 1}`, sheet: !!ref.contact_sheet }));
    const seconds = Math.min(10, Math.max(2, Number(args.seconds) || 5));
    return {
        images: refs.map((ref, i) => ({ name: `ref-${i}.png`, path: ref.path })),
        spec: { refs: named.map((r) => ({ role: r.role, name: r.name, sheet: r.sheet, tag: r.name })), story: String(args.story), style: String(args.style || ''), sound: String(args.sound || ''), voices: false },
        seconds, ...quality, aspect: ratio, audio: args.audio === 'off' ? 'off' : 'on',
        ...(Number.isInteger(args.seed) ? { seed: args.seed } : {}),
    };
}

// ─── The tools ──────────────────────────────────────────────────────
function createMediaTools(deps) {
    const jobs = deps.jobs || createJobs();
    const emit = (event) => { try { deps.notify?.(event); } catch { /* UI feedback is optional */ } };
    const waitProp = { type: 'integer', minimum: 0, maximum: MAX_WAIT, description: `Seconds to wait for the result before answering with a job id (default 25, max ${MAX_WAIT}). Use job_status to keep waiting.` };

    /** Run a long piece of work as a job and wait a little for it. */
    async function submit({ tool, label, lane = 'gpu', run, cancel, wait }) {
        emit({ phase: 'start', tool, label });
        const job = jobs.start({
            name: label, lane, cancel,
            run: async (j) => {
                try {
                    const result = await run(j);
                    if (result?.event) emit({ phase: 'media-result', tool, ...result.event }); // also when the assistant is no longer waiting
                    return result;
                } catch (err) { emit({ phase: 'error', tool, message: String(err?.message || err) }); throw err; }
            },
        });
        await jobs.wait(job, wait === undefined ? 25 : wait);
        if (job.state === 'error') throw new Error(job.error);
        return { content: [text(describeJob(job))] };
    }

    const fileOk = deps.fileOk || ((f) => path.isAbsolute(String(f || '')) && fs.existsSync(f) && fs.statSync(f).isFile());
    const mediaLine = (kind, result, extra = '') => [`${kind}${extra}.`, result.path ? `File: ${result.path}` : null].filter(Boolean).join('\n');

    return [
        // ── Video, lip sync, music, sound effects (Wan2GP) ──
        {
            name: 'generate_video',
            description: 'Make a video clip with a local video model (Wan2GP): from a text prompt, or from a picture (image-to-video) when image_path is given. Takes minutes; runs as a job.',
            inputSchema: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'What happens in the clip. Any language (translated).' },
                    image_path: { type: 'string', description: 'Absolute path of the start picture (image-to-video models need it).' },
                    model: { type: 'string', description: 'Video model id or part of its name (list_models with kind "video").' },
                    aspect_ratio: { type: 'string', enum: Object.keys(ASPECTS), description: 'Default 16:9' },
                    video_length: { type: 'integer', description: 'Frames, if you want a specific length. Omit for the model default.' },
                    steps: { type: 'integer' }, seed: { type: 'integer' }, negative_prompt: { type: 'string' }, wait_seconds: waitProp,
                },
                required: ['prompt'],
            },
            run: async (a) => {
                if (!String(a.prompt || '').trim()) throw new Error('prompt is required.');
                if (a.image_path && !fileOk(a.image_path)) throw new Error('image_path must be the absolute path of an existing picture.');
                const model = pickModel(await deps.listModels(), 'video', a.model);
                return submit({
                    tool: 'generate_video', label: `video with ${model.name}`, cancel: deps.cancelEngines, wait: a.wait_seconds,
                    run: async () => {
                        const r = await deps.generate({ model: model.id, prompt: a.prompt, image: a.image_path, aspect_ratio: ASPECTS[a.aspect_ratio] ? a.aspect_ratio : '16:9', video_length: a.video_length, steps: a.steps, seed: a.seed, negative_prompt: a.negative_prompt });
                        return { summary: mediaLine('Video made', r, ` with ${model.name}`), path: r.path, event: { kind: 'video', path: r.path, prompt: a.prompt } };
                    },
                });
            },
        },
        {
            name: 'make_lipsync',
            description: 'Make a talking video from a portrait picture and an audio file (InfiniteTalk, local). The clip lasts as long as the audio. Runs as a job.',
            inputSchema: {
                type: 'object',
                properties: {
                    image_path: { type: 'string', description: 'Absolute path of the portrait.' }, audio_path: { type: 'string', description: 'Absolute path of the speech or song.' },
                    prompt: { type: 'string', description: 'Optional: the talking style or motion.' }, model: { type: 'string' },
                    aspect_ratio: { type: 'string', enum: Object.keys(ASPECTS) }, seed: { type: 'integer' }, wait_seconds: waitProp,
                },
                required: ['image_path', 'audio_path'],
            },
            run: async (a) => {
                if (!fileOk(a.image_path)) throw new Error('image_path must be the absolute path of an existing picture.');
                if (!fileOk(a.audio_path)) throw new Error('audio_path must be the absolute path of an existing audio file.');
                const model = pickModel(await deps.listModels(), 'lipsync', a.model);
                return submit({
                    tool: 'make_lipsync', label: `lip sync with ${model.name}`, cancel: deps.cancelEngines, wait: a.wait_seconds,
                    run: async () => {
                        const r = await deps.generate({ model: model.id, prompt: a.prompt || '', image: a.image_path, audio: a.audio_path, aspect_ratio: ASPECTS[a.aspect_ratio] ? a.aspect_ratio : '1:1', seed: a.seed });
                        return { summary: mediaLine('Talking video made', r, ` with ${model.name}`), path: r.path, event: { kind: 'video', path: r.path, prompt: a.prompt || 'lip sync' } };
                    },
                });
            },
        },
        ...[['generate_music', 'wan2gp:stable-audio3-music', 'music', 'Make music from a description (genre, tempo, instruments, mood) with Stable Audio 3, on this PC.'],
            ['generate_sound_effect', 'wan2gp:stable-audio3-sfx', 'sound effect', 'Make a sound effect from a description (a whoosh, a sword clash, rain) with Stable Audio 3, on this PC.']].map(([name, model, noun, description]) => ({
            name,
            description: `${description} Returns an audio file you can use as a movie soundtrack (music_path) or a scene sound (sfx_path). Runs as a job.`,
            inputSchema: {
                type: 'object',
                properties: { prompt: { type: 'string', description: 'Describe the sound. Any language.' }, seconds: { type: 'integer', minimum: 2, maximum: 120, description: 'Length, default 30 for music and 5 for effects.' }, seed: { type: 'integer' }, wait_seconds: waitProp },
                required: ['prompt'],
            },
            run: async (a) => {
                if (!String(a.prompt || '').trim()) throw new Error('prompt is required.');
                const picked = pickModel(await deps.listModels(), 'audio', model);
                const seconds = Math.min(120, Math.max(2, Math.round(Number(a.seconds) || (name === 'generate_music' ? 30 : 5))));
                return submit({
                    tool: name, label: `${noun} (${seconds} s)`, cancel: deps.cancelEngines, wait: a.wait_seconds,
                    run: async () => {
                        const r = await deps.generate({ model: picked.id, prompt: a.prompt, duration_seconds: seconds, seed: a.seed });
                        if (!r?.path) throw new Error('The audio model returned no file.');
                        return { summary: mediaLine(`Made a ${noun} of ${seconds} s`, r), path: r.path, event: { kind: 'audio', path: r.path, prompt: a.prompt } };
                    },
                });
            },
        })),

        // ── MiniMax H3 (Anime tab and the movie shots) ──
        {
            name: 'h3_shot',
            description: 'Make a video shot with MiniMax H3 from reference pictures (needs ComfyUI with H3, see movie_options). The references (a character, a place, an object) are what the shot keeps faithful; the story says what happens. Use it for movie shots and for the Anime (H3) tab. A shot takes about 5-12 minutes; runs as a job.',
            inputSchema: {
                type: 'object',
                properties: {
                    story: { type: 'string', description: 'What happens, naming the references (English works best).' },
                    references: {
                        type: 'array', minItems: 1, maxItems: 4, description: 'Up to 4 pictures.',
                        items: { type: 'object', properties: { path: { type: 'string' }, role: { type: 'string', enum: ['character', 'place', 'object'] }, name: { type: 'string', description: 'The name used in the story.' }, contact_sheet: { type: 'boolean', description: 'The picture shows the same subject from several sides.' } }, required: ['path'] },
                    },
                    style: { type: 'string', description: 'Look of the shot, e.g. "warm cinematic light, shallow depth of field".' },
                    sound: { type: 'string', description: 'Sound effects of the shot (no voices).' },
                    seconds: { type: 'number', minimum: 2, maximum: 10, description: 'Default 5.' },
                    quality: { type: 'string', enum: Object.keys(QUALITY), description: 'standard = fastest; sharp adds a second, detailed pass (about +1 min); best is the sharpest.' },
                    aspect_ratio: { type: 'string', enum: Object.keys(ASPECTS), description: 'Use 9:16 for a vertical reel. Default 16:9.' },
                    seed: { type: 'integer' }, audio: { type: 'string', enum: ['on', 'off'] }, wait_seconds: waitProp,
                },
                required: ['story', 'references'],
            },
            run: async (a) => {
                const params = buildH3Params(a, { fileOk });
                return submit({
                    tool: 'h3_shot', label: `H3 shot (${params.seconds} s)`, cancel: deps.cancelEngines, wait: a.wait_seconds,
                    run: async () => {
                        const r = await deps.h3(params);
                        return { summary: mediaLine('Shot made with MiniMax H3', r), path: r.path, event: { kind: 'video', path: r.path, prompt: a.story } };
                    },
                });
            },
        },

        // ── The movie maker ──
        {
            name: 'movie_options',
            description: 'What the movie maker offers: transition ids, title and caption styles (the ones whose font is installed), formats, motions and what is installed (ffmpeg, MiniMax H3). Read it before movie_render so the ids are valid.',
            inputSchema: { type: 'object', properties: {} },
            run: async () => {
                const o = deps.movie.movieOptions();
                const status = await deps.movieStatus?.();
                const group = (list) => {
                    const by = {};
                    for (const [id, label, g] of list) (by[g] = by[g] || []).push(`${id} (${label})`);
                    return Object.entries(by).map(([g, items]) => `  ${g}: ${items.join(', ')}`).join('\n');
                };
                return {
                    content: [text([
                        `Transitions: ${o.transitions.map(([id]) => id).join(', ')}`,
                        `Title styles:\n${group(o.titleStyles)}`,
                        `Caption styles:\n${group(o.captionStyles)}`,
                        'Formats: any width x height, e.g. 1280x720 (wide), 720x1280 or 1080x1920 (vertical reel), 1080x1080 (square).',
                        'Image motions: zoom-in, zoom-out, pan-left, pan-right, none.',
                        'Upscale targets: 1080p, 1440p, 4k; methods: fast (keeps faces natural) or ai (ComfyUI, slow).',
                        status ? `Installed: ${status}` : '',
                    ].filter(Boolean).join('\n'))],
                };
            },
        },
        {
            name: 'movie_storyboard',
            description: 'Let the local writer (Qwen) turn an idea into shots: for each shot a picture/video description, a camera motion, a caption and a sound, plus a title and a music description. The assistant can then make each shot (h3_shot, generate_video), compose the music and call movie_render.',
            inputSchema: {
                type: 'object',
                properties: {
                    idea: { type: 'string' }, shots: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 6.' }, style: { type: 'string' },
                    aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'], description: 'Shape of the movie.' },
                    references: { type: 'array', description: 'The people, places and objects of the story.', items: { type: 'object', properties: { role: { type: 'string', enum: ['character', 'place', 'object'] }, name: { type: 'string' }, notes: { type: 'string' } }, required: ['name'] } },
                    wait_seconds: waitProp,
                },
                required: ['idea'],
            },
            run: async (a) => {
                if (!String(a.idea || '').trim()) throw new Error('idea is required.');
                return submit({
                    tool: 'movie_storyboard', label: 'storyboard', wait: a.wait_seconds,
                    run: async () => {
                        const result = await deps.storyboard({ idea: a.idea, scenes: Math.min(20, Math.max(1, Number(a.shots) || 6)), style: a.style || '', aspect: ASPECTS[a.aspect_ratio] ? a.aspect_ratio : '16:9', refs: (a.references || []).map((r) => ({ role: r.role || 'object', name: r.name, notes: r.notes || '' })) });
                        return { summary: `Storyboard:\n${JSON.stringify(result, null, 2)}` };
                    },
                });
            },
        },
        {
            name: 'movie_render',
            description: 'Put a movie together with ffmpeg: video clips, pictures and title cards in order, with captions, titles, transitions, the sound of the clips, a music track and fades. Returns the movie file. Use movie_options for the valid ids. Runs as a job (usually seconds).',
            inputSchema: {
                type: 'object',
                properties: {
                    scenes: {
                        type: 'array', minItems: 1, description: 'The scenes in order.',
                        items: {
                            type: 'object',
                            properties: {
                                type: { type: 'string', enum: ['video', 'image', 'title'], description: 'Default: image or video from the file, title when there is no file.' },
                                path: { type: 'string', description: 'Absolute path of the clip or picture.' },
                                duration: { type: 'number', description: 'Seconds for pictures and title cards.' }, trim_seconds: { type: 'number', description: 'Use only the first N seconds of a clip.' },
                                motion: { type: 'string', enum: ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'none'], description: 'For pictures.' },
                                caption: { type: 'string' }, caption_style: { type: 'string' },
                                title: { type: 'string', description: 'A big title over the scene, or the text of a title card.' }, subtitle: { type: 'string' }, title_style: { type: 'string' }, title_color: { type: 'string', description: 'e.g. #e9c46a' },
                                color: { type: 'string', description: 'Background of a title card, e.g. #0b0f1a.' }, transition_in: { type: 'string', description: 'Transition from the previous scene (default: the movie transition).' },
                                sfx_path: { type: 'string', description: 'A sound effect for this scene.' }, sfx_volume: { type: 'number' },
                            },
                        },
                    },
                    format: { type: 'string', description: 'width x height, default 1280x720. 720x1280 or 1080x1920 for a vertical reel.' },
                    fps: { type: 'integer', enum: [24, 25, 30, 60] }, transition: { type: 'string' }, transition_seconds: { type: 'number' },
                    music_path: { type: 'string' }, music_volume: { type: 'number', description: '0 to 1, default 0.4.' },
                    keep_clip_audio: { type: 'boolean' }, fade_in_out: { type: 'boolean' }, quality: { type: 'string', enum: ['final', 'preview'], description: 'preview = half size, quick check.' },
                    wait_seconds: waitProp,
                },
                required: ['scenes'],
            },
            run: async (a) => {
                const project = buildMovieProject(a, { options: deps.movie.movieOptions(), fileOk });
                return submit({
                    tool: 'movie_render', label: 'movie render', lane: 'movie', cancel: deps.movie.cancel, wait: a.wait_seconds,
                    run: async () => {
                        const r = await deps.movie.render(project);
                        return { summary: `Movie made: ${r.seconds?.toFixed ? r.seconds.toFixed(1) : r.seconds} s, ${r.width}x${r.height}, ${(r.bytes / 1048576).toFixed(1)} MB.\nFile: ${r.path}`, path: r.path, event: { kind: 'movie', path: r.path, seconds: r.seconds } };
                    },
                });
            },
        },
        {
            name: 'movie_upscale',
            description: 'Make a finished movie bigger (final upscale to Full HD, 2K or 4K). "fast" is Lanczos with a light sharpen that keeps faces natural; "ai" uses an upscale model in ComfyUI (slow, can smooth faces). Runs as a job.',
            inputSchema: {
                type: 'object',
                properties: { input_path: { type: 'string' }, target: { type: 'string', enum: ['1080p', '1440p', '4k'] }, method: { type: 'string', enum: ['fast', 'ai'] }, model: { type: 'string', description: 'AI method only: an upscale model file in ComfyUI.' }, strength: { type: 'number', description: 'AI method: how much of the AI result is blended in (0..1, default 0.4).' }, wait_seconds: waitProp },
                required: ['input_path'],
            },
            run: async (a) => {
                if (!fileOk(a.input_path)) throw new Error('input_path must be the absolute path of an existing video.');
                return submit({
                    tool: 'movie_upscale', label: 'final upscale', lane: 'movie', cancel: deps.movie.cancelUpscale, wait: a.wait_seconds,
                    run: async () => {
                        const r = await deps.movie.upscale({ input: a.input_path, target: a.target || '1080p', method: a.method === 'ai' ? 'ai' : 'fast', model: a.model || '', strength: a.strength });
                        return { summary: `Upscaled movie: ${r.width}x${r.height}.\nFile: ${r.path}`, path: r.path, event: { kind: 'movie', path: r.path } };
                    },
                });
            },
        },
        {
            name: 'movie_title_clip',
            description: 'Make a title as a video with a transparent background (ProRes 4444 .mov or VP9 .webm) to use in another editor. save_path is where the file goes.',
            inputSchema: {
                type: 'object',
                properties: { title: { type: 'string' }, subtitle: { type: 'string' }, title_style: { type: 'string' }, title_color: { type: 'string' }, seconds: { type: 'number' }, format: { type: 'string', enum: ['mov', 'webm'] }, size: { type: 'string', description: 'width x height, default 1920x1080' }, fps: { type: 'integer' }, save_path: { type: 'string', description: 'Absolute path of the file to write.' } },
                required: ['title', 'save_path'],
            },
            run: async (a) => {
                if (!path.isAbsolute(String(a.save_path || ''))) throw new Error('save_path must be an absolute path.');
                const size = parseFormat({ format: a.size || '1920x1080' });
                return submit({
                    tool: 'movie_title_clip', label: 'transparent title', lane: 'movie', wait: 55,
                    run: async () => {
                        const file = await deps.movie.exportTitle({ title: a.title, subtitle: a.subtitle, titleStyle: a.title_style, titleColor: a.title_color, seconds: Number(a.seconds) || 4, width: size.width, height: size.height, fps: Number(a.fps) || 30, format: a.format === 'webm' ? 'webm' : 'mov', savePath: a.save_path });
                        return { summary: `Title saved.\nFile: ${file}` };
                    },
                });
            },
        },
        {
            name: 'movie_last_frame',
            description: 'Save the last frame of a clip as a picture (a look reference for the next shot).',
            inputSchema: { type: 'object', properties: { video_path: { type: 'string' } }, required: ['video_path'] },
            run: async (a) => {
                if (!fileOk(a.video_path)) throw new Error('video_path must be the absolute path of an existing video.');
                const r = deps.movie.lastFrame(a.video_path);
                return { content: [text(`Last frame saved.\nFile: ${r.path}`)] };
            },
        },
        {
            name: 'movie_probe',
            description: 'Duration, size and whether it has sound, for video, audio or picture files.',
            inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 } }, required: ['paths'] },
            run: async (a) => {
                const rows = (a.paths || []).map((f) => { try { const i = deps.movie.probeFile(deps.movie.checkMediaPath(f)); return `${f}: ${i.duration ? `${Number(i.duration).toFixed(2)} s` : 'picture'}${i.width ? `, ${i.width}x${i.height}` : ''}${i.hasAudio ? ', has sound' : ''}`; } catch (err) { return `${f}: ${err.message}`; } });
                return { content: [text(rows.join('\n'))] };
            },
        },
        {
            name: 'movie_library',
            description: 'Everything the app made that can go into a movie: clips (video studios, H3), pictures and finished movies, newest first.',
            inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 30.' } } },
            run: async (a) => {
                const items = deps.movie.library().slice(0, Math.min(100, Math.max(1, Number(a.limit) || 30)));
                return { content: [text(items.length ? items.map((i) => `${i.modifiedAt || ''}  [${i.source || ''}]  ${i.path}`).join('\n') : 'Nothing made yet.')] };
            },
        },
        {
            name: 'movie_open_in_app',
            description: 'Load a movie project (the same scenes as movie_render) into the Movie tab, so the user can look at it, change captions or styles and render it from the interface.',
            inputSchema: { type: 'object', properties: { scenes: { type: 'array', minItems: 1, items: { type: 'object' } }, format: { type: 'string' }, fps: { type: 'integer' }, transition: { type: 'string' }, transition_seconds: { type: 'number' }, music_path: { type: 'string' }, music_volume: { type: 'number' }, keep_clip_audio: { type: 'boolean' }, fade_in_out: { type: 'boolean' } }, required: ['scenes'] },
            run: async (a) => {
                const project = buildMovieProject(a, { options: deps.movie.movieOptions(), fileOk });
                const durations = {};
                for (const clip of project.clips) {
                    if (clip.kind !== 'video') continue;
                    try { durations[clip.path] = deps.movie.probeFile(deps.movie.checkMediaPath(clip.path)).duration; } catch { /* the interface probes again */ }
                }
                emit({ phase: 'movie-project', project: buildInterfaceProject(project, durations) });
                return { content: [text(`The project (${project.clips.length} scenes, ${project.width}x${project.height}) is open in the Movie tab.`)] };
            },
        },

        // ── Pictures, folders, diagnostics ──
        {
            name: 'edit_picture',
            description: 'Crop, rotate, flip and adjust brightness, contrast and colour of a picture (the app\'s picture editor). The original is untouched; a new PNG is saved. Crop is in fractions of the picture after rotation/flip, e.g. {x:0.3,y:0.05,width:0.4,height:0.4} keeps a box in the upper middle: useful to cut a face out of a bigger photo for a reference.',
            inputSchema: {
                type: 'object',
                properties: {
                    image_path: { type: 'string' }, rotate: { type: 'integer', enum: [0, 90, 180, 270] }, flip: { type: 'boolean', description: 'Mirror left to right.' },
                    crop: { type: 'object', properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 }, width: { type: 'number', minimum: 0.02, maximum: 1 }, height: { type: 'number', minimum: 0.02, maximum: 1 } } },
                    brightness: { type: 'integer', minimum: 40, maximum: 180, description: 'Percent, 100 = unchanged.' }, contrast: { type: 'integer', minimum: 40, maximum: 180 }, saturation: { type: 'integer', minimum: 40, maximum: 180 },
                },
                required: ['image_path'],
            },
            run: async (a) => {
                if (!fileOk(a.image_path)) throw new Error('image_path must be the absolute path of an existing picture.');
                const r = deps.movie.editPicture({ input: a.image_path, rotate: a.rotate, flip: a.flip, crop: a.crop, brightness: a.brightness, contrast: a.contrast, saturation: a.saturation });
                return { content: [text(`Picture saved (the original is unchanged).\nFile: ${r.path}`)] };
            },
        },
        {
            name: 'show_folder',
            description: 'Open a results folder in the file explorer: media (pictures and video studios), anime (H3 clips), movies (finished movies) or all.',
            inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['media', 'anime', 'movies', 'all'] } }, required: ['kind'] },
            run: async (a) => ({ content: [text(`Opened ${await deps.openFolder(a.kind)}`)] }),
        },
        {
            name: 'debug_log',
            description: 'The app\'s debug log: what each tool did and why something failed (prompts sent to the models, errors, timings). Use it to diagnose a failed job.',
            inputSchema: { type: 'object', properties: { lines: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 40.' }, level: { type: 'string', enum: ['all', 'warn', 'error'] }, search: { type: 'string' } } },
            run: async (a) => ({ content: [text(deps.debugLog({ lines: Math.min(200, Math.max(1, Number(a.lines) || 40)), level: a.level || 'all', search: a.search || '' }) || 'The log is empty.')] }),
        },

        // ── Jobs ──
        {
            name: 'job_status',
            description: 'State of a long job (video, shot, movie…): queued, running, done (with the file) or failed. wait_seconds keeps waiting for it to finish.',
            inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, wait_seconds: waitProp }, required: ['job_id'] },
            run: async (a) => {
                const job = jobs.get(a.job_id);
                if (!job) throw new Error(`No job ${a.job_id}. list_jobs shows the recent ones.`);
                await jobs.wait(job, a.wait_seconds === undefined ? 25 : a.wait_seconds);
                if (job.state === 'error') throw new Error(`${job.id} failed: ${job.error}`);
                return { content: [text(describeJob(job))] };
            },
        },
        {
            name: 'list_jobs',
            description: 'The recent jobs of this session, newest first.',
            inputSchema: { type: 'object', properties: {} },
            run: async () => ({ content: [text(jobs.list().map((j) => describeJob(j).split('\n')[0]).join('\n') || 'No jobs yet.')] }),
        },
        {
            name: 'cancel_job',
            description: 'Cancel a queued or running job.',
            inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
            run: async (a) => {
                const job = jobs.get(a.job_id);
                if (!job) throw new Error(`No job ${a.job_id}.`);
                return { content: [text(jobs.cancel(job) ? `Cancel requested for ${job.id}.` : `${job.id} had already finished.`)] };
            },
        },
    ];
}

module.exports = { createJobs, createMediaTools, buildMovieProject, buildInterfaceProject, buildH3Params, parseFormat, describeJob, ASPECTS, QUALITY };
