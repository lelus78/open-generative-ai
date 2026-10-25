const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

const wf = require('../electron/lib/comfyH3Workflow');
const { composeH3Prompt, tagNames } = require('../electron/lib/comfyH3Prompt');
const miniWs = require('../electron/lib/miniWs');

test('frame counts are at least 5 and land on (n - 5) % 17 === 0', () => {
    for (const seconds of [0.1, 1, 6, 8, 12.5, 13, 15]) {
        const frames = wf.framesForSeconds(seconds);
        assert.ok(frames >= 5);
        assert.equal((frames - 5) % 17, 0, `${seconds}s → ${frames}`);
        assert.ok(frames >= Math.round(seconds * wf.FPS) || seconds < 0.3);
    }
    assert.equal(wf.framesForSeconds(6), 158);
    assert.equal(wf.framesForSeconds(12.5), 311);
});

test('sizes are multiples of 32 close to the megapixel budget', () => {
    for (const mp of [0.2, 0.3, 0.4, 0.6, 0.8]) {
        const { width, height } = wf.sizeForMegapixels(mp);
        assert.equal(width % 32, 0);
        assert.equal(height % 32, 0);
        assert.ok(Math.abs(width * height / 1e6 - mp) < 0.06, `${mp} → ${width}x${height}`);
    }
});

test('graph wires references, and the upscale pass replaces the decode input', () => {
    const base = wf.buildH3Graph({ prompt: 'p', images: ['a.png', 'b.png'], seconds: 6, megapixels: 0.4, seed: 7 });
    assert.deepEqual(base[10].inputs['ref_images.ref_image_1'], ['21', 0]);
    assert.equal(base[21].inputs.image, 'b.png');
    assert.equal(base[13].class_type, 'VAEDecode');
    assert.equal(base[wf.NODE_BASE_SAMPLER].inputs.seed, 7);
    assert.equal(base[33], undefined);

    const up = wf.buildH3Graph({ prompt: 'p', images: ['a.png'], seconds: 6, megapixels: 0.3, upscaleMegapixels: 0.6, seed: 7 });
    assert.equal(up[13].class_type, 'VAEDecodeTiled');
    assert.deepEqual(up[13].inputs.samples, [wf.NODE_REFINE_SAMPLER, 0]);
    assert.deepEqual(up[14].inputs.samples, [wf.NODE_REFINE_SAMPLER, 0]);
    assert.equal(up[31].inputs['mode.megapixels'], 0.6);
    assert.equal(up[wf.NODE_REFINE_SAMPLER].inputs.denoise, 0.5);
    // every link points at a node that exists
    for (const node of Object.values(up)) {
        for (const value of Object.values(node.inputs)) {
            if (Array.isArray(value)) assert.ok(up[value[0]], `dangling link to ${value[0]}`);
        }
    }
});

test('graph rejects zero or too many references', () => {
    assert.throws(() => wf.buildH3Graph({ prompt: 'p', images: [], seconds: 6, megapixels: 0.4, seed: 1 }), /at least one/);
    assert.throws(() => wf.buildH3Graph({ prompt: 'p', images: ['1', '2', '3', '4', '5'], seconds: 6, megapixels: 0.4, seed: 1 }), /At most/);
});

test('names in the story become subject tags, whole words only', () => {
    const refs = [{ name: 'Mika' }, { name: 'Bedroom' }];
    assert.equal(tagNames('Mika walks into the bedroom. Mikado stays.', refs), '<Subject 1> walks into the <Subject 2>. Mikado stays.');
    assert.equal(tagNames('x', [{ name: 'a' }]), 'x'); // one-letter names are ignored
});

test('composed prompt has every H3 section and one block per reference', () => {
    const prompt = composeH3Prompt({
        refs: [{ role: 'character', name: 'Mika' }, { role: 'place', name: 'Bedroom' }],
        story: 'Mika picks up her headphones in the Bedroom.',
    });
    for (const section of ['subject_definitions:', 'summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:']) {
        assert.ok(prompt.includes(section), section);
    }
    assert.ok(prompt.includes('<Subject 1> is Mika in <Picture 1>'));
    assert.ok(prompt.includes('<Subject 2> is Bedroom in <Picture 2>'));
    assert.ok(prompt.includes('<Subject 1> picks up her headphones in the <Subject 2>.'));
    assert.equal(prompt.match(/fully_preserved/g).length, 2);
    assert.throws(() => composeH3Prompt({ refs: [], story: 'x' }), /reference/);
    assert.throws(() => composeH3Prompt({ refs: [{}], story: '  ' }), /Describe/);
});

test('miniWs completes the handshake, receives text and binary messages, and answers pings', async () => {
    const received = [];
    const server = http.createServer();
    server.on('upgrade', (req, socket) => {
        const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        const text = Buffer.from('{"type":"hello"}');
        socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]));
        const big = Buffer.alloc(70000, 7);                       // 64-bit length path
        const head = Buffer.alloc(10); head[0] = 0x82; head[1] = 127; head.writeBigUInt64BE(BigInt(big.length), 2);
        socket.write(Buffer.concat([head, big]));
        socket.write(Buffer.from([0x89, 0]));                      // ping
        socket.on('data', (chunk) => { if ((chunk[0] & 0x0f) === 0xA) socket.end(); }); // pong → done
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const closed = new Promise((resolve) => {
        miniWs.connect({
            port: server.address().port, path: '/ws',
            onMessage: (data, binary) => received.push({ binary, length: data.length, data }),
            onClose: resolve,
        });
    });
    await closed;
    server.close();
    assert.equal(received[0].binary, false);
    assert.equal(received[0].data, '{"type":"hello"}');
    assert.equal(received[1].binary, true);
    assert.equal(received[1].length, 70000);
});

test('a stand-in tag lets the story name references the user left unnamed', () => {
    const refs = [{ name: '', tag: 'Character 1' }, { name: 'Bridge', tag: 'Bridge' }];
    assert.equal(tagNames('Character 1 crosses the Bridge.', refs), '<Subject 1> crosses the <Subject 2>.');
    const prompt = composeH3Prompt({ refs: [{ role: 'character', name: '', tag: 'Character 1' }], story: 'Character 1 waves.' });
    assert.ok(prompt.includes('<Subject 1> waves.'));
});

test('story requests list every reference and parse the model answer', () => {
    const { buildStoriesRequest, parseStoryLines } = require('../electron/lib/promptTranslator');
    const request = buildStoriesRequest({ refs: [{ role: 'character', name: 'Mika', notes: 'blue hair' }, { role: 'place', name: 'Bridge' }], seconds: 12, genre: 'Fantasy', count: 3 });
    assert.match(request, /N = 3/);
    assert.match(request, /12 seconds/);
    assert.match(request, /1\. Mika \(character\): blue hair/);
    assert.match(request, /2\. Bridge \(place\)/);
    const stories = parseStoryLines('<think>plan</think>\n1. **Night Run** :: Mika sprints over the Bridge as lanterns light up.\nSure, here you go:\n2. Quiet :: Mika sits on the Bridge and watches the river flow by.\n3. Tiny :: no');
    assert.deepEqual(stories.map((s) => s.title), ['Night Run', 'Quiet']);
    assert.equal(stories[0].story, 'Mika sprints over the Bridge as lanterns light up.');
});

test('story lines are accepted with a ::, colon or dash after the title, or without a title', () => {
    const { parseStoryLines } = require('../electron/lib/promptTranslator');
    const found = parseStoryLines([
        '1. Night Run: Mika sprints over the Bridge as the lanterns light up.',
        '2. Quiet Morning - Mika sits on the Bridge and watches the river flow by.',
        '3. Mika stops mid-step on the Bridge; the railings shimmer and a ripple spreads across the stream.',
    ].join('\n'));
    assert.deepEqual(found.map((s) => s.title), ['Night Run', 'Quiet Morning', '']);
    assert.ok(found[2].story.startsWith('Mika stops mid-step'));
});

test('contact sheet prompts wrap the subject, keep it first, and ban text and people as needed', async () => {
    const { applySheet, pickSheetAspect, nextSheet } = await import('../src/lib/contactSheet.js');
    const character = applySheet('character', 'a cyberpunk hacker with pink hair.');
    assert.ok(character.startsWith('character design reference sheet of a cyberpunk hacker with pink hair. '));
    assert.match(character, /front view, side profile, back of the head/);
    assert.match(character, /no text, no labels/);
    const place = applySheet('environment', 'a rainy neon street');
    assert.match(place, /2x2 grid of four panels/);
    assert.match(place, /no people/);
    assert.equal(applySheet('off', 'x y z'), 'x y z');
    assert.equal(applySheet('character', '  '), '  ');   // nothing to wrap
    assert.equal(nextSheet('off'), 'character');
    assert.equal(nextSheet('character'), 'environment');
    assert.equal(nextSheet('environment'), 'off');
    assert.equal(pickSheetAspect('character', ['1:1', '16:9', '3:4']), '3:4');
    assert.equal(pickSheetAspect('environment', ['1:1', '16:9', '3:4']), '16:9');
    assert.equal(pickSheetAspect('environment', ['9:16']), null);
});

test('a contact sheet reference is declared as a sheet that must not be copied into the scene', () => {
    const sheet = composeH3Prompt({ refs: [{ role: 'character', sheet: true, tag: 'Mika' }, { role: 'place', sheet: true, tag: 'Lab' }], story: 'Mika enters the Lab.' });
    assert.match(sheet, /the character reference sheet that shows the same character from several sides/);
    assert.match(sheet, /never as several copies/);
    assert.match(sheet, /the environment reference sheet that shows the same location from several camera angles/);
    const plain = composeH3Prompt({ refs: [{ role: 'character', tag: 'Mika' }], story: 'Mika waves.' });
    assert.doesNotMatch(plain, /reference sheet/);
});

test('debug log keeps a bounded list, clips long text, writes a rotating file and tells listeners', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { createDebugLog, formatEntries } = require('../electron/lib/debugLog');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-log-'));
    const file = path.join(dir, 'debug.log');
    let clock = new Date(2026, 9, 24, 15, 30, 5, 42).getTime();
    const log = createDebugLog({ file, max: 3, maxFileBytes: 400, now: () => clock });
    const heard = [];
    const stop = log.onEntry((entry) => heard.push(entry.message));

    log.info('translate', 'one', { long: 'x'.repeat(5000) });
    assert.match(log.entries()[0].data.long, /\+3500 chars/);          // clipped by default
    log.setVerbose(true);
    log.warn('translate', 'two', { long: 'x'.repeat(5000) });
    assert.equal(log.entries()[1].data.long.length, 5000);              // kept whole in verbose mode
    log.error('image', 'three', new Error('boom'));
    log.info('app', 'four');
    assert.deepEqual(log.entries().map((e) => e.message), ['two', 'three', 'four']);   // only the last 3
    assert.deepEqual(heard, ['one', 'two', 'three', 'four']);
    stop(); log.info('app', 'five');
    assert.equal(heard.length, 4);

    assert.ok(fs.existsSync(file));
    assert.ok(fs.existsSync(`${file}.1`), 'the file rotates when it grows past the limit');
    const text = formatEntries([{ id: 1, t: clock, level: 'error', scope: 'image', message: 'sd-cli FAILED', data: { code: 3 } }]);
    assert.match(text, /^\[15:30:05\.042\] ERROR image: sd-cli FAILED\n {4}\{/);
    assert.equal(log.entries().every((e) => typeof e.id === 'number'), true);
});

test('sound: voices are forbidden unless asked for, and a silent video drops the audio nodes', () => {
    const { NO_VOICES } = require('../electron/lib/comfyH3Prompt');
    const quiet = composeH3Prompt({ refs: [{ role: 'character', tag: 'Mika' }], story: 'Mika waves.', sound: 'Soft wind.' });
    assert.ok(quiet.includes(`overall_soundscape: Soft wind. ${NO_VOICES}`));
    const chatty = composeH3Prompt({ refs: [{ role: 'character', tag: 'Mika' }], story: 'Mika waves.', voices: true });
    assert.ok(!chatty.includes(NO_VOICES));

    const withSound = wf.buildH3Graph({ prompt: 'p', images: ['a.png'], seconds: 4, megapixels: 0.3, seed: 1 });
    assert.ok(withSound[14] && withSound[15].inputs.audio);
    const silent = wf.buildH3Graph({ prompt: 'p', images: ['a.png'], seconds: 4, megapixels: 0.3, upscaleMegapixels: 0.6, seed: 1, audio: false });
    assert.equal(silent[14], undefined);
    assert.equal('audio' in silent[15].inputs, false);
    for (const node of Object.values(silent)) {          // nothing may point at the removed node
        for (const value of Object.values(node.inputs)) if (Array.isArray(value)) assert.ok(silent[value[0]], `dangling link to ${value[0]}`);
    }
});
