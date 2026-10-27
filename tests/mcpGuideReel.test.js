const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHandler } = require('../electron/lib/mcpServer');
const { createTools } = require('../electron/lib/mcpTools');
const { createJobs, createMediaTools, jobInfo, describeJob } = require('../electron/lib/mcpMedia');
const { INSTRUCTIONS, PROMPTS } = require('../electron/lib/mcpGuide');
const reel = require('../electron/lib/reelDirector');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-reel-'));
const photos = ['01_raw.png', '02_paint.png', '03_done.png', '04_detail.png', '05_worn.png'].map((name) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, 'x');
    return f;
});

const imageDeps = {
    listModels: async () => [{ id: 'z-image-turbo', name: 'Z-Image Turbo', kind: 'image', ready: true, downloaded: true, fit: 'recommended' }],
    generate: async () => ({ path: 'C:/x/image.png', seed: 7, url: 'C:/x/image.png' }),
    enhance: async (x) => `better ${x}`, cancel: () => {}, recent: () => [{ path: 'C:/x/a.png', modifiedAt: '2026-10-27' }], notify: () => {},
};

function mediaDeps(overrides = {}) {
    const calls = [];
    const events = [];
    return {
        calls, events,
        listModels: async () => [],
        notify: (e) => events.push(e),
        // the 3rd photo is the most striking one, the 5th the next best
        reelAnalyse: async (paths) => paths.map((p, i) => ({ path: p, score: [0.2, 0.3, 0.9, 0.4, 0.6][i] })),
        movie: {
            movieOptions: () => ({ transitions: [['fade', 'Cross-fade']], titleStyles: [], captionStyles: [] }),
            render: async (project) => { calls.push(project); return { path: `C:/out/reel-${calls.length}.mp4`, seconds: 10, width: project.width, height: project.height, bytes: 1 }; },
            cancel: () => {},
        },
        ...overrides,
    };
}

test('initialize carries the instructions and the prompts are listed and filled in', async () => {
    const handle = createHandler({ name: 't', version: '1', tools: createTools(imageDeps), instructions: INSTRUCTIONS, prompts: PROMPTS });
    const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.match(init.result.instructions, /job_status/);
    assert.deepEqual(init.result.capabilities.prompts, { listChanged: false });

    const list = await handle({ jsonrpc: '2.0', id: 2, method: 'prompts/list' });
    assert.deepEqual(list.result.prompts.map((p) => p.name), ['reel_from_photos', 'product_spot', 'music_video']);
    assert.equal(list.result.prompts[0].build, undefined, 'only protocol fields are sent');

    const got = await handle({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'reel_from_photos', arguments: { photos: 'D:/lab/axe', goal: 'sell' } } });
    assert.equal(got.result.messages[0].role, 'user');
    assert.match(got.result.messages[0].content.text, /D:\/lab\/axe[\s\S]*Goal: sell[\s\S]*movie_reel/);

    assert.equal((await handle({ jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'reel_from_photos', arguments: {} } })).error.code, -32602);
    assert.equal((await handle({ jsonrpc: '2.0', id: 5, method: 'prompts/get', params: { name: 'nope' } })).error.code, -32602);
});

test('every tool says whether it only reads, makes something or stops work', async () => {
    const handle = createHandler({ name: 't', version: '1', tools: [...createTools(imageDeps), ...createMediaTools(mediaDeps())] });
    const { tools } = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result;
    for (const tool of tools) assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', tool.name);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    assert.equal(byName.list_models.readOnlyHint, true);
    assert.equal(byName.job_status.readOnlyHint, true);
    assert.equal(byName.generate_image.destructiveHint, false);
    assert.equal(byName.cancel_job.destructiveHint, true);
    assert.equal(byName.movie_title_clip.destructiveHint, true);
    assert.ok(tools.every((t) => t.annotations.openWorldHint === false), 'everything stays on this PC');
});

test('results carry structured content next to the text', async () => {
    const tools = Object.fromEntries(createTools(imageDeps).map((t) => [t.name, t]));
    assert.equal((await tools.list_models.run({})).structuredContent.models[0].id, 'z-image-turbo');
    assert.deepEqual((await tools.recent_results.run({})).structuredContent.items, [{ path: 'C:/x/a.png', modified_at: '2026-10-27' }]);
    const image = await tools.generate_image.run({ prompt: 'a fox' });
    assert.deepEqual(image.structuredContent, { path: 'C:/x/image.png', model: 'z-image-turbo', seed: 7 });
});

test('jobs report progress, a time estimate from the measured pace and every change', async () => {
    let t = 0;
    const jobs = createJobs({ now: () => t });
    const changes = [];
    jobs.onChange((j) => changes.push(j.state));
    let finish;
    const job = jobs.start({ name: 'video', run: () => new Promise((resolve) => { finish = resolve; }) });
    await new Promise((r) => setImmediate(r));
    assert.equal(job.state, 'running');

    t = 60000; // a minute loading the model: not part of the estimate
    jobs.report('gpu', { fraction: 0, phase: 'starting' });
    jobs.report('gpu', { fraction: 0.1, phase: 'generating' });
    t = 80000;
    jobs.report('gpu', { fraction: 0.3 });
    const info = jobInfo(job, t);
    assert.equal(info.progress, 0.3);
    assert.equal(info.phase, 'generating');
    assert.equal(info.eta_seconds, 70); // 20 s for 20 % → 70 s for the 70 % left
    assert.match(describeJob(job, t), /30% of generating, about 70 s left/);

    jobs.report('gpu', { fraction: 0.05, phase: 'upscale' }); // a new phase starts its own count and estimate
    assert.equal(jobInfo(job, t).eta_seconds, undefined);

    finish({ summary: 'ok', path: 'C:/v.mp4' });
    await job.done;
    assert.equal(jobInfo(job).path, 'C:/v.mp4');
    assert.equal(jobInfo(job).eta_seconds, undefined);
    assert.deepEqual([...new Set(changes)], ['queued', 'running', 'done']);
    assert.equal(jobs.report('gpu', { fraction: 0.5 }), null, 'no running job, nothing to update');
});

test('measurePixels tells a sharp colourful photo from a flat grey one', () => {
    const size = 32;
    const flat = Buffer.alloc(size * size * 4, 128);
    const busy = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
        const on = ((i % size) + Math.floor(i / size)) % 2;
        busy.set([on ? 255 : 0, on ? 40 : 200, on ? 0 : 255, 255], i * 4);
    }
    const a = reel.measurePixels(flat, size, size);
    const b = reel.measurePixels(busy, size, size);
    assert.ok(b.sharpness > a.sharpness && b.colorfulness > a.colorfulness && b.contrast > a.contrast);
    const ranked = reel.rankScores([{ path: 'flat', ...a }, { path: 'busy', ...b }]);
    assert.deepEqual(ranked.map((r) => r.score), [0, 1]);
    assert.throws(() => reel.measurePixels(Buffer.alloc(4), 10, 10), /could not be read/);
});

test('planReel opens on the best photo, keeps the story order and fits the cut', () => {
    const list = photos.map((p, i) => ({ path: p, score: [0.2, 0.3, 0.9, 0.4, 0.6][i], faces: i === 1 }));
    const d = reel.planReel({ photos: list, variant: 'discovery', texts: { hook: 'Yes, 3D printed', handle: '@lab' } });
    assert.equal(d.goal, 'followers');
    assert.equal(d.format, '1080x1920');
    assert.equal(d.scenes[0].path, photos[2]);
    assert.equal(d.scenes[0].title, 'Yes, 3D printed');
    assert.deepEqual(d.scenes.slice(1, -1).map((s) => s.path), [photos[0], photos[1], photos[3], photos[4]]);
    assert.equal(d.scenes.at(-1).title, 'Follow for more');
    assert.equal(d.scenes.at(-1).subtitle, '@lab');
    assert.ok(d.seconds >= 8 && d.seconds <= 12, `discovery lasts ${d.seconds} s`);
    assert.deepEqual(d.protected_faces, [photos[1]]);

    const s = reel.planReel({ photos: list, variant: 'showcase', goal: 'sell' });
    assert.ok(s.seconds > d.seconds);
    assert.equal(s.scenes.at(-1).title, 'Want one?');
    assert.equal(s.scenes.at(-1).subtitle, 'Link in bio');
    assert.equal(s.transition_seconds, 0.5);

    assert.throws(() => reel.planReel({ photos: list.slice(0, 2) }), /at least 3 photos/);
    assert.throws(() => reel.planReel({ photos: list, goal: 'fame' }), /goal must be/);
});

test('planReel with more photos than the cut takes keeps the best ones in order', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ path: `p${i}.png`, score: i % 3 === 0 ? 0.1 : 0.5 + i / 100 }));
    const plan = reel.planReel({ photos: many, variant: 'discovery' });
    const story = plan.scenes.slice(1, -1).map((s) => Number(s.path.slice(1, -4)));
    assert.equal(story.length, reel.VARIANTS.discovery.maxPhotos);
    assert.deepEqual(story, [...story].sort((a, b) => a - b), 'story order kept');
    assert.ok(plan.left_out.length > 0);
});

test('listPhotos reads a folder in name order', () => {
    assert.deepEqual(reel.listPhotos(dir), photos);
    assert.throws(() => reel.listPhotos(path.join(dir, 'missing')), /list of picture paths or the path of a folder/);
});

test('movie_reel plans, opens in the Movie tab and renders both cuts as one job', async () => {
    const deps = mediaDeps();
    const tool = createMediaTools(deps).find((t) => t.name === 'movie_reel');

    const plan = await tool.run({ folder: dir, variant: 'both', faces: [photos[1]], handle: '@lab' });
    assert.deepEqual(plan.structuredContent.plans.map((p) => p.variant), ['discovery', 'showcase']);
    assert.equal(plan.structuredContent.plans[0].opener, photos[2]);
    assert.match(plan.content[0].text, /Kept original \(real faces\): 02_paint\.png/);

    const opened = await tool.run({ photos, action: 'open' });
    assert.match(opened.content[0].text, /open in the Movie tab/);
    const project = deps.events.find((e) => e.phase === 'movie-project').project;
    assert.equal(project.format, '1080x1920');
    assert.equal(project.scenes[0].path, photos[2]);

    const rendered = await tool.run({ photos, variant: 'both', action: 'render', wait_seconds: 5 });
    assert.equal(rendered.structuredContent.state, 'done');
    assert.deepEqual(rendered.structuredContent.result.movies.map((m) => m.variant), ['discovery', 'showcase']);
    assert.equal(deps.calls.length, 2);
    assert.equal(deps.calls[0].width, 1080);

    await assert.rejects(() => tool.run({ photos: [photos[0], 'C:/nope.png', photos[2]] }), /photos\[1\] must be/);
});

test('a reel and a movie carry a name, so their folder says what they are', () => {
    const { buildMovieProject } = require('../electron/lib/mcpMedia');
    const plan = reel.planReel({ photos: photos.map((p) => ({ path: p })), variant: 'showcase', texts: { title: 'Viking axe' } });
    assert.equal(plan.name, 'reel showcase - Viking axe');
    assert.equal(buildMovieProject(plan, { fileOk: () => true }).name, 'reel showcase - Viking axe');
    assert.equal(buildMovieProject({ scenes: [{ title: 'Hi' }] }, { fileOk: () => true }).name, undefined);
});
