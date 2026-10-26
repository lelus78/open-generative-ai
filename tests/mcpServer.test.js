const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createHandler, authorize, start } = require('../electron/lib/mcpServer');
const { createTools, pickModel } = require('../electron/lib/mcpTools');
const { recentResults } = require('../electron/lib/outputStore');

const models = [
    { id: 'sd-old', name: 'Dreamshaper 8', kind: 'image', ready: true, downloaded: true, fit: 'recommended', legacy: true },
    { id: 'wan2gp:big', name: 'Big Model', kind: 'image', ready: true, downloaded: false, fit: 'recommended' },
    { id: 'z-image-turbo', name: 'Z-Image Turbo', kind: 'image', ready: true, downloaded: true, fit: 'recommended' },
    { id: 'wan2gp:heavy', name: 'Heavy Model', kind: 'image', ready: false, downloaded: false, fit: 'unfit', reason: 'needs 24 GB of VRAM' },
    { id: 'wan2gp:kroma-edit', name: 'Kroma Edit', kind: 'edit', ready: true, downloaded: true, fit: 'recommended' },
];

test('pickModel prefers downloaded, non-legacy models and explains refusals', () => {
    assert.equal(pickModel(models, 'image').id, 'z-image-turbo');
    assert.equal(pickModel(models, 'image', 'dreamshaper').id, 'sd-old');
    assert.equal(pickModel(models, 'edit').id, 'wan2gp:kroma-edit');
    assert.throws(() => pickModel(models, 'image', 'heavy'), /24 GB of VRAM/);
    assert.throws(() => pickModel(models, 'image', 'nope'), /No image model matches/);
    assert.throws(() => pickModel(models, 'video'), /No video model is ready/);
});

const fakeDeps = (overrides = {}) => {
    const events = [];
    const calls = [];
    return {
        events,
        calls,
        listModels: async () => models,
        generate: async (params) => { calls.push(params); return { url: 'data:image/png;base64,AAAA', path: 'C:/x/image.png', seed: 5, translatedPrompt: 'a fox' }; },
        enhance: async (t) => `enhanced ${t}`,
        cancel: () => calls.push('cancel'),
        recent: () => [],
        notify: (e) => events.push(e),
        ...overrides,
    };
};

test('the protocol: initialize, tools/list, tools/call, errors, notifications', async () => {
    const deps = fakeDeps();
    const handle = createHandler({ name: 't', version: '1', tools: createTools(deps) });

    const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.deepEqual(init.result.serverInfo, { name: 't', version: '1' });
    assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);

    const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(list.result.tools.map(t => t.name), ['list_models', 'generate_image', 'edit_image', 'enhance_prompt', 'recent_results', 'cancel_generation']);

    const gen = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: 'una volpe', aspect_ratio: '16:9' } } });
    assert.equal(gen.result.isError, undefined);
    assert.equal(deps.calls[0].model, 'z-image-turbo');
    assert.equal(deps.calls[0].aspect_ratio, '16:9');
    assert.match(gen.result.content[0].text, /File: C:\/x\/image\.png/);
    assert.equal(gen.result.content[1].type, 'image');
    assert.deepEqual(deps.events.map(e => e.phase), ['start', 'result']);
    assert.equal(deps.events[1].entry.model, 'local:z-image-turbo');

    const bad = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: ' ' } } });
    assert.equal(bad.result.isError, true);
    assert.equal((await handle({ jsonrpc: '2.0', id: 5, method: 'nope' })).error.code, -32601);
    assert.equal((await handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'zzz' } })).error.code, -32602);
});

test('edit_image needs a real picture and uses an edit model', async () => {
    const deps = fakeDeps();
    const edit = createTools(deps).find(t => t.name === 'edit_image');
    await assert.rejects(() => edit.run({ image_path: 'relative.png', prompt: 'x' }), /absolute path/);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-')), 'dog.png');
    fs.writeFileSync(file, 'x');
    await edit.run({ image_path: file, prompt: 'make it black' });
    assert.equal(deps.calls[0].model, 'wan2gp:kroma-edit');
    assert.equal(deps.calls[0].image, file);
});

test('a failing generation is reported to the app and to the model', async () => {
    const deps = fakeDeps({ generate: async () => { throw new Error('out of memory'); } });
    const handle = createHandler({ name: 't', version: '1', tools: createTools(deps) });
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: 'x' } } });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /out of memory/);
    assert.equal(deps.events.at(-1).phase, 'error');
});

test('authorize: token, no Origin, local host only', () => {
    const ok = { host: '127.0.0.1:5000', authorization: 'Bearer secret' };
    assert.equal(authorize({ headers: ok, token: 'secret', port: 5000 }), 200);
    assert.equal(authorize({ headers: { ...ok, authorization: 'Bearer wrong' }, token: 'secret', port: 5000 }), 401);
    assert.equal(authorize({ headers: { host: ok.host }, token: 'secret', port: 5000 }), 401);
    assert.equal(authorize({ headers: { ...ok, origin: 'https://evil.example' }, token: 'secret', port: 5000 }), 403);
    assert.equal(authorize({ headers: { ...ok, host: 'evil.example:5000' }, token: 'secret', port: 5000 }), 403);
});

const post = (port, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
        let data = '';
        res.on('data', d => { data += d; });
        res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
});

test('over HTTP: needs the token, answers JSON-RPC, 202 for notifications', async () => {
    const handle = createHandler({ name: 't', version: '1', tools: createTools(fakeDeps()) });
    const probe = http.createServer().listen(0, '127.0.0.1');
    await new Promise(r => probe.once('listening', r));
    const port = probe.address().port;
    await new Promise(r => probe.close(r));

    const server = await start({ port, token: 'tok', handle });
    try {
        const auth = { Authorization: 'Bearer tok' };
        assert.equal((await post(port, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
        const pong = await post(port, { jsonrpc: '2.0', id: 1, method: 'ping' }, auth);
        assert.equal(pong.status, 200);
        assert.deepEqual(pong.body.result, {});
        assert.equal((await post(port, { jsonrpc: '2.0', method: 'notifications/initialized' }, auth)).status, 202);
        assert.equal((await post(port, { jsonrpc: '2.0', id: 2, method: 'ping' }, { ...auth, Origin: 'https://evil.example' })).status, 403);
        const batch = await post(port, [{ jsonrpc: '2.0', id: 7, method: 'ping' }, { jsonrpc: '2.0', id: 8, method: 'ping' }], auth);
        assert.equal(batch.body.length, 2);
    } finally {
        server.closeAllConnections?.();
        await new Promise(r => server.close(r));
    }
});

test('recentResults lists the newest media first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-'));
    for (const [run, name, age] of [['1', 'a.png', 3000], ['2', 'b.jpg', 1000], ['3', 'notes.txt', 0]]) {
        fs.mkdirSync(path.join(dir, run, 'out'), { recursive: true });
        const file = path.join(dir, run, 'out', name);
        fs.writeFileSync(file, 'x');
        const t = new Date(Date.now() - age);
        fs.utimesSync(file, t, t);
    }
    const list = recentResults(dir, 5);
    assert.deepEqual(list.map(i => path.basename(i.path)), ['b.jpg', 'a.png']);
});

test('with a shared job list a slow picture answers with a job id and the picture is found later', async () => {
    const { createJobs } = require('../electron/lib/mcpMedia');
    const jobs = createJobs();
    let release;
    const gate = new Promise((r) => { release = r; });
    const deps = fakeDeps({ jobs, generate: async () => { await gate; return { url: 'data:image/png;base64,AAAA', path: 'C:/x/slow.png', seed: 1 }; } });
    const gen = createTools(deps).find((t) => t.name === 'generate_image');
    const first = await gen.run({ prompt: 'una volpe', wait_seconds: 0 });
    assert.match(first.content[0].text, /job-\d+/);
    release();
    const job = jobs.list()[0];
    await jobs.wait(job, 5);
    assert.equal(job.state, 'done');
    assert.match(job.result.content[0].text, /slow\.png/);
});
