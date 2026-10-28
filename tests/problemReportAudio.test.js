const test = require('node:test');
const assert = require('node:assert/strict');

const { anonymize, issueUrl, MAX_URL } = require('../electron/lib/problemReport');
const { limiterArgs, movieLoudnessFilter } = require('../electron/lib/audioLevel');
const { createTools } = require('../electron/lib/mcpTools');
const { INSTRUCTIONS } = require('../electron/lib/mcpGuide');

test('anonymize removes the home folder in every spelling and the user name', () => {
    const who = { home: 'C:\\Users\\lelus', user: 'lelus' };
    const log = [
        'saved C:\\Users\\lelus\\AppData\\Roaming\\x.png',
        'url file:///C:/Users/lelus/Pictures/a%20b.png',
        'json "C:\\\\Users\\\\lelus\\\\models"',
        'user lelus started; lelusX stays',
    ].join('\n');
    const out = anonymize(log, who);
    assert.ok(!/lelus\b/i.test(out.replace('lelusX', '')), out);
    assert.match(out, /~\\AppData/);
    assert.match(out, /file:\/\/\/~\/Pictures/);
    assert.match(out, /<user> started/);
});

test('issueUrl fills the GitHub form and keeps the newest log lines under the URL limit', () => {
    const log = Array.from({ length: 2000 }, (_, i) => `[00:00:${i}] INFO line ${i} ${'x'.repeat(40)}`).join('\n');
    const url = issueUrl({ version: '2.2.7', platform: 'Windows_NT 10 x64', gpu: 'RTX 5070 Ti 16 GB', log });
    assert.ok(url.startsWith('https://github.com/lelus78/open-generative-ai/issues/new?title='));
    assert.ok(url.length <= MAX_URL, String(url.length));
    const body = decodeURIComponent(url.split('&body=')[1]);
    assert.match(body, /2\.2\.7 · Windows_NT 10 x64 · RTX 5070 Ti 16 GB/);
    assert.match(body, /line 1999 /);
    assert.doesNotMatch(body, /line 0 /);
});

test('the limiter keeps the format, adds no make-up gain and stops at -1 dBFS', () => {
    const args = limiterArgs('in.wav', 'out.wav');
    assert.ok(args.includes('alimiter=limit=0.891:level=false'));
    assert.deepEqual(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 2), ['-c:a', 'pcm_s24le']);
    assert.match(movieLoudnessFilter(), /^loudnorm=I=-14:/);
});

test('enhance_prompt passes the kind of media to the writer', async () => {
    const calls = [];
    const tools = createTools({ listModels: async () => [], generate: async () => ({}), enhance: async (t, k) => { calls.push(k); return `${k}: ${t}`; }, cancel: () => {}, recent: () => [], notify: () => {} });
    const tool = tools.find((t) => t.name === 'enhance_prompt');
    assert.deepEqual(tool.inputSchema.properties.kind.enum, ['image', 'video', 'music', 'sfx']);
    assert.equal((await tool.run({ prompt: 'car skids', kind: 'sfx' })).structuredContent.prompt, 'sfx: car skids');
    await tool.run({ prompt: 'x', kind: 'nonsense' });
    assert.deepEqual(calls, ['sfx', 'image']);
});

test('the MCP guide tells the assistant how to read errors', () => {
    assert.match(INSTRUCTIONS, /Reading errors/);
    assert.match(INSTRUCTIONS, /out of memory/);
    assert.match(INSTRUCTIONS, /kind image, video, music or sfx/);
});
