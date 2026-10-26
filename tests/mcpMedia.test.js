const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHandler } = require('../electron/lib/mcpServer');
const { createTools } = require('../electron/lib/mcpTools');
const { createJobs, createMediaTools, buildMovieProject, buildInterfaceProject, buildH3Params, parseFormat } = require('../electron/lib/mcpMedia');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-media-'));
const file = (name) => { const f = path.join(dir, name); fs.writeFileSync(f, 'x'); return f; };
const clip = file('clip.mp4');
const pic = file('pic.png');
const song = file('song.wav');

const options = {
    transitions: [['fade', 'Cross-fade'], ['wipeleft', 'Wipe left']],
    titleStyles: [['classic', 'Classic', 'Clean', {}], ['cinzel', 'Cinzel capitals', 'Elegant', {}]],
    captionStyles: [['subtitle', 'Subtitle', 'Classic', {}], ['cinzel', 'Cinzel capitals', 'Elegant', {}]],
};

const models = [
    { id: 'wan2gp:wan-t2v', name: 'Wan 2.1', kind: 'video', ready: true, downloaded: true, fit: 'recommended' },
    { id: 'wan2gp:infinitetalk', name: 'InfiniteTalk', kind: 'lipsync', ready: true, downloaded: true, fit: 'recommended' },
    { id: 'wan2gp:stable-audio3-music', name: 'Stable Audio 3 music', kind: 'audio', ready: true, downloaded: true, fit: 'recommended' },
    { id: 'wan2gp:stable-audio3-sfx', name: 'Stable Audio 3 sfx', kind: 'audio', ready: false, downloaded: false, reason: 'not downloaded yet' },
];

function fakeDeps(overrides = {}) {
    const calls = [];
    const events = [];
    return {
        calls, events,
        listModels: async () => models,
        generate: async (params) => { calls.push(['generate', params]); return { path: 'C:/out/result.bin', seed: 1 }; },
        h3: async (params) => { calls.push(['h3', params]); return { path: 'C:/out/shot.mp4' }; },
        storyboard: async (req) => { calls.push(['storyboard', req]); return { title: 'T', shots: [{ image: 'a' }] }; },
        notify: (e) => events.push(e),
        cancelEngines: () => calls.push('cancelEngines'),
        openFolder: async (kind) => `C:/folders/${kind}`,
        debugLog: ({ lines, level }) => `log ${lines} ${level}`,
        movieStatus: async () => 'ffmpeg ok',
        movie: {
            movieOptions: () => options,
            render: async (project) => { calls.push(['render', project]); return { path: 'C:/out/movie.mp4', seconds: 12, width: project.width, height: project.height, bytes: 2097152 }; },
            upscale: async (p) => { calls.push(['upscale', p]); return { path: 'C:/out/big.mp4', width: 1080, height: 1920 }; },
            exportTitle: async (p) => { calls.push(['title', p]); return p.savePath; },
            lastFrame: (f) => ({ path: `${f}.png` }),
            probeFile: () => ({ duration: 5.2, width: 720, height: 1280, hasAudio: true }),
            checkMediaPath: (f) => f,
            editPicture: (p) => { calls.push(['edit', p]); return { path: 'C:/out/edit.png' }; },
            library: () => [{ path: 'C:/a.mp4', source: 'H3', modifiedAt: '2026-10-26' }],
            cancel: () => calls.push('cancelMovie'), cancelUpscale: () => calls.push('cancelUpscale'),
        },
        ...overrides,
    };
}
const toolMap = (deps) => Object.fromEntries(createMediaTools(deps).map((t) => [t.name, t]));
const text = (r) => r.content.map((c) => c.text).join('\n');

test('the app is covered: every studio has a tool', () => {
    const names = createMediaTools(fakeDeps()).map((t) => t.name);
    for (const wanted of ['generate_video', 'make_lipsync', 'generate_music', 'generate_sound_effect', 'h3_shot', 'movie_options', 'movie_storyboard', 'movie_render', 'movie_upscale', 'movie_title_clip', 'movie_open_in_app', 'edit_picture', 'show_folder', 'debug_log', 'job_status', 'cancel_job']) {
        assert.ok(names.includes(wanted), wanted);
    }
    assert.equal(new Set(names).size, names.length, 'names are unique');
});

test('jobs run one after the other in a lane and report their state', async () => {
    const jobs = createJobs();
    const order = [];
    const slow = jobs.start({ name: 'slow', run: async () => { await new Promise((r) => setTimeout(r, 30)); order.push('slow'); return { summary: 'a' }; } });
    const quick = jobs.start({ name: 'quick', run: async () => { order.push('quick'); return { summary: 'b' }; } });
    const other = jobs.start({ name: 'other lane', lane: 'movie', run: async () => { order.push('other'); return {}; } });
    assert.equal(quick.state, 'queued');
    await Promise.all([slow.done, quick.done, other.done]);
    assert.deepEqual(order.filter((x) => x !== 'other'), ['slow', 'quick']);
    assert.equal(slow.state, 'done');
    const failing = jobs.start({ name: 'bad', run: async () => { throw new Error('boom'); } });
    await failing.done;
    assert.equal(failing.state, 'error');
    assert.equal(failing.error, 'boom');
    const waiting = jobs.start({ name: 'w', run: async () => { await new Promise((r) => setTimeout(r, 40)); return {}; } });
    const queued = jobs.start({ name: 'q', run: async () => ({}) });
    assert.equal(jobs.cancel(queued), true);
    await waiting.done; await queued.done;
    assert.equal(queued.state, 'cancelled');
});

test('generate_video picks a video model, waits and returns the file; a slow job answers with its id', async () => {
    const deps = fakeDeps();
    const t = toolMap(deps);
    const out = await t.generate_video.run({ prompt: 'a fox running', image_path: pic, aspect_ratio: '9:16' });
    assert.match(text(out), /Video made with Wan 2\.1/);
    assert.match(text(out), /File: C:\/out\/result\.bin/);
    const [, params] = deps.calls.find((c) => c[0] === 'generate');
    assert.equal(params.model, 'wan2gp:wan-t2v');
    assert.equal(params.aspect_ratio, '9:16');
    assert.equal(params.image, pic);
    assert.ok(deps.events.some((e) => e.phase === 'media-result' && e.kind === 'video'));

    const slow = fakeDeps({ generate: async () => { await new Promise((r) => setTimeout(r, 80)); return { path: 'C:/late.mp4' }; } });
    const ts = toolMap(slow);
    const first = await ts.generate_video.run({ prompt: 'x', wait_seconds: 0 });
    const id = /job-\d+/.exec(text(first))[0];
    assert.match(text(first), /still running|waiting/);
    const done = await ts.job_status.run({ job_id: id, wait_seconds: 5 });
    assert.match(text(done), /is done/);
    assert.match(text(done), /C:\/late\.mp4/);
    await assert.rejects(() => t.generate_video.run({ prompt: 'x', image_path: 'nope.png' }), /image_path/);
});

test('music and sound effects use the Stable Audio models and respect what is downloaded', async () => {
    const deps = fakeDeps();
    const t = toolMap(deps);
    const out = await t.generate_music.run({ prompt: 'epic strings', seconds: 40 });
    assert.match(text(out), /Made a music of 40 s/);
    const [, params] = deps.calls.find((c) => c[0] === 'generate');
    assert.equal(params.model, 'wan2gp:stable-audio3-music');
    assert.equal(params.duration_seconds, 40);
    await assert.rejects(() => t.generate_sound_effect.run({ prompt: 'whoosh' }), /not downloaded yet/);
});

test('make_lipsync needs a portrait and an audio file', async () => {
    const deps = fakeDeps();
    const t = toolMap(deps);
    await assert.rejects(() => t.make_lipsync.run({ image_path: pic, audio_path: 'missing.wav' }), /audio_path/);
    const out = await t.make_lipsync.run({ image_path: pic, audio_path: song });
    assert.match(text(out), /Talking video made/);
    const [, params] = deps.calls.find((c) => c[0] === 'generate');
    assert.equal(params.audio, song);
    assert.equal(params.model, 'wan2gp:infinitetalk');
});

test('h3_shot validates the references and shapes the generator parameters', async () => {
    const p = buildH3Params({ story: 'Ambra raises the axe', references: [{ path: pic, role: 'character', name: 'Ambra' }, { path: pic }], aspect_ratio: '9:16', quality: 'sharp', seconds: 4, seed: 7 });
    assert.equal(p.images.length, 2);
    assert.equal(p.spec.refs[0].tag, 'Ambra');
    assert.equal(p.spec.refs[1].role, 'object');
    assert.equal(p.upscale, true);
    assert.ok(Math.abs(p.aspect - 9 / 16) < 1e-9);
    assert.equal(p.seed, 7);
    assert.throws(() => buildH3Params({ story: '', references: [{ path: pic }] }), /story/);
    assert.throws(() => buildH3Params({ story: 'x', references: [] }), /references/);
    assert.throws(() => buildH3Params({ story: 'x', references: [{ path: 'missing.png' }] }), /references\[0\]\.path/);
    const deps = fakeDeps();
    const out = await toolMap(deps).h3_shot.run({ story: 'a shot', references: [{ path: pic }] });
    assert.match(text(out), /Shot made with MiniMax H3/);
    assert.equal(deps.calls.find((c) => c[0] === 'h3')[1].seconds, 5);
});

test('movie_render builds the project, checks style and transition ids and returns the movie', async () => {
    const args = {
        format: '720x1280', fps: 30, transition: 'wipeleft', music_path: song,
        scenes: [
            { type: 'video', path: clip, trim_seconds: 3.5, caption: 'Hello', caption_style: 'cinzel' },
            { path: pic, duration: 3, motion: 'zoom-out', title: 'Big', title_style: 'classic' },
            { title: 'The end', subtitle: 'ambryslab', duration: 2 },
        ],
    };
    const project = buildMovieProject(args, { options });
    assert.equal(project.width, 720);
    assert.equal(project.height, 1280);
    assert.equal(project.clips[0].trimEnd, 3.5);
    assert.equal(project.clips[0].captionStyle, 'cinzel');
    assert.equal(project.clips[1].kind, 'image');
    assert.equal(project.clips[2].kind, 'title');
    assert.equal(project.music.volume, 0.4);
    assert.throws(() => buildMovieProject({ ...args, transition: 'nope' }, { options }), /not a known transition/);
    assert.throws(() => buildMovieProject({ scenes: [{ path: clip, caption_style: 'comic' }] }, { options }), /caption_style/);
    assert.throws(() => buildMovieProject({ scenes: [] }, { options }), /at least one scene/);
    assert.throws(() => buildMovieProject({ scenes: [{ path: 'missing.mp4' }] }, { options }), /scenes\[0\]\.path/);
    assert.throws(() => parseFormat({ format: '100x100' }), /between 240 and 4096/);

    const deps = fakeDeps();
    const out = await toolMap(deps).movie_render.run(args);
    assert.match(text(out), /Movie made: 12\.0 s, 720x1280, 2\.0 MB/);
    assert.match(text(out), /File: C:\/out\/movie\.mp4/);
    assert.equal(deps.calls.find((c) => c[0] === 'render')[1].clips.length, 3);
});

test('movie_open_in_app hands the project to the Movie tab with probed durations', async () => {
    const deps = fakeDeps();
    const out = await toolMap(deps).movie_open_in_app.run({ format: '720x1280', scenes: [{ path: clip, caption: 'Hi' }, { title: 'End' }] });
    assert.match(text(out), /open in the Movie tab/);
    const event = deps.events.find((e) => e.phase === 'movie-project');
    assert.equal(event.project.format, '720x1280');
    assert.equal(event.project.scenes[0].duration, 5.2);
    assert.equal(event.project.scenes[0].caption, 'Hi');
    assert.equal(event.project.scenes[1].kind, 'title');
    const project = buildMovieProject({ scenes: [{ path: clip }] }, { options });
    assert.equal(buildInterfaceProject(project, {}).scenes[0].duration, 5);
});

test('the other movie tools: upscale, title clip, picture edit, folders, log, options', async () => {
    const deps = fakeDeps();
    const t = toolMap(deps);
    assert.match(text(await t.movie_upscale.run({ input_path: clip, target: '1080p' })), /Upscaled movie: 1080x1920/);
    assert.equal(deps.calls.find((c) => c[0] === 'upscale')[1].method, 'fast');
    const titlePath = path.join(dir, 'title.mov');
    assert.match(text(await t.movie_title_clip.run({ title: 'Hi', save_path: titlePath, size: '1280x720' })), /Title saved/);
    assert.equal(deps.calls.find((c) => c[0] === 'title')[1].savePath, titlePath);
    await assert.rejects(() => t.movie_title_clip.run({ title: 'Hi', save_path: 'relative.mov' }), /absolute/);
    assert.match(text(await t.edit_picture.run({ image_path: pic, crop: { x: 0.3, y: 0.1, width: 0.4, height: 0.4 }, rotate: 90 })), /Picture saved/);
    assert.deepEqual(deps.calls.find((c) => c[0] === 'edit')[1].crop, { x: 0.3, y: 0.1, width: 0.4, height: 0.4 });
    assert.match(text(await t.show_folder.run({ kind: 'movies' })), /C:\/folders\/movies/);
    assert.match(text(await t.debug_log.run({ lines: 5, level: 'error' })), /log 5 error/);
    const opts = text(await t.movie_options.run({}));
    assert.match(opts, /Transitions: fade, wipeleft/);
    assert.match(opts, /Elegant: cinzel \(Cinzel capitals\)/);
    assert.match(opts, /ffmpeg ok/);
    assert.match(text(await t.movie_storyboard.run({ idea: 'a reel', shots: 3, aspect_ratio: '9:16' })), /"title": "T"/);
    assert.match(text(await t.list_jobs.run({})), /job-/);
    assert.match(text(await t.movie_library.run({})), /C:\/a\.mp4/);
});

test('through the protocol: the new tools are listed next to the image tools', async () => {
    const deps = fakeDeps();
    const imageDeps = { listModels: async () => models, generate: async () => ({}), enhance: async (x) => x, cancel: () => {}, recent: () => [], notify: () => {} };
    const handle = createHandler({ name: 't', version: '1', tools: [...createTools(imageDeps), ...createMediaTools(deps)] });
    const list = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = list.result.tools.map((x) => x.name);
    assert.ok(names.includes('generate_image') && names.includes('movie_render') && names.includes('job_status'));
    const call = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'generate_video', arguments: { prompt: '' } } });
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /prompt is required/);
});
