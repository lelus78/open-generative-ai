const test = require('node:test');
const assert = require('node:assert/strict');

const { needsTranslation, buildChatPrompt, parseTranslation, pickAsset } = require('../electron/lib/promptTranslator');

test('English prompts are left alone', () => {
    for (const text of [
        'a grasshopper on a wooden fence on a gloomy overcast morning',
        '@batman working at mcdonad',
        'portrait of an old fisherman, dramatic lighting, 85mm',
        'cyberpunk street at night, neon rain',
        'a woman in a red dress',
        'Z-Image Turbo',
        '',
        'ok',
    ]) assert.equal(needsTranslation(text), false, text);
});

test('Italian, Spanish, French, German and Portuguese prompts are detected', () => {
    for (const text of [
        'una cavalletta su una staccionata in una mattina uggiosa',
        'un gatto sul tetto della casa con la luna',
        'una mujer con un vestido rojo en la playa por la mañana',
        'une femme avec un chapeau sur la plage dans la nuit',
        'ein Mann mit einem Hund auf der Straße und die Sonne',
        'uma casa com um jardim muito bonito para a manhã',
    ]) assert.equal(needsTranslation(text), true, text);
});

test('non-Latin scripts are always translated', () => {
    assert.equal(needsTranslation('一只蚂蚱在木栅栏上'), true);
    assert.equal(needsTranslation('кузнечик на заборе'), true);
});

test('a couple of foreign words inside an English prompt do not trigger it', () => {
    assert.equal(needsTranslation('a plate of pasta con pesto, studio lighting'), false);
});

test('chat prompt uses the ChatML format of Qwen models', () => {
    const prompt = buildChatPrompt('ciao');
    assert.match(prompt, /^<\|im_start\|>system\n/);
    assert.match(prompt, /<\|im_start\|>user\nciao<\|im_end\|>\n<\|im_start\|>assistant\n$/);
});

test('parseTranslation cleans the model output and rejects bad answers', () => {
    assert.equal(parseTranslation('a grasshopper on a fence [end of text]\n\n\n', 'una cavalletta'), 'a grasshopper on a fence');
    assert.equal(parseTranslation('"a red apple"', 'una mela rossa'), 'a red apple');
    assert.equal(parseTranslation('', 'ciao'), '');
    assert.equal(parseTranslation('x'.repeat(5000), 'ciao'), '');
    assert.equal(parseTranslation('first line\n\nExplanation: I translated...', 'una mela'), 'first line');
});

test('pickAsset prefers the GPU build and falls back to the CPU one', () => {
    const releases = [{ assets: [{ name: 'llama-b1-bin-win-cpu-x64.zip' }, { name: 'llama-b1-bin-win-vulkan-x64.zip' }, { name: 'llama-b1-bin-win-cuda-12.4-x64.zip' }] }];
    assert.equal(pickAsset(releases, 'win32-x64').name, 'llama-b1-bin-win-vulkan-x64.zip');
    const cpuOnly = [{ assets: [{ name: 'llama-b1-bin-win-cpu-x64.zip' }] }];
    assert.equal(pickAsset(cpuOnly, 'win32-x64').name, 'llama-b1-bin-win-cpu-x64.zip');
    assert.equal(pickAsset(releases, 'plan9-x64'), null);
});

test('translations survive a restart (disk cache)', async () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
    fs.writeFileSync(path.join(dir, 'translation-cache.json'), JSON.stringify([['una cavalletta su una staccionata', 'a grasshopper on a fence']]));
    const { createPromptTranslator } = require('../electron/lib/promptTranslator');
    const t = createPromptTranslator({ getPaths: () => ({ dataDir: dir, modelsDir: dir }), downloadFile: async () => {}, llmFilename: 'none.gguf', settingsFile: path.join(dir, 'settings.json') });
    const r = await t.translateParams({ prompt: 'una cavalletta su una staccionata', seed: 7 });
    assert.equal(r.params.prompt, 'a grasshopper on a fence');
});
