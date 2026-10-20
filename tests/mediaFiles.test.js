const test = require('node:test');
const assert = require('node:assert/strict');

const { decodeDataUrl, defaultFileName, labelsFor } = require('../electron/lib/mediaFiles');

test('decodeDataUrl decodes base64 and percent-encoded data URLs', () => {
    const png = decodeDataUrl('data:image/png;base64,aGVsbG8=');
    assert.equal(png.mime, 'image/png');
    assert.equal(png.buffer.toString(), 'hello');
    assert.equal(decodeDataUrl('data:text/plain,hi%20there').buffer.toString(), 'hi there');
    assert.equal(decodeDataUrl('https://example.com/a.png'), null);
    assert.equal(decodeDataUrl(''), null);
});

test('defaultFileName keeps a real name from the URL and invents one otherwise', () => {
    assert.equal(defaultFileName('file:///C:/runs/123/out/clip%20one.mp4', 'video'), 'clip one.mp4');
    assert.equal(defaultFileName('https://cdn.example.com/x/photo.jpg?sig=1', 'image'), 'photo.jpg');
    assert.equal(defaultFileName('data:image/png;base64,AAAA', 'image', 42), 'image-42.png');
    assert.equal(defaultFileName('data:image/jpeg;base64,AAAA', 'image', 7), 'image-7.jpg');
    assert.equal(defaultFileName('https://cdn.example.com/stream', 'video', 5), 'video-5.mp4');
    assert.equal(defaultFileName('', 'audio', 9), 'audio-9.mp3');
});

test('labelsFor follows the system language and falls back to English', () => {
    assert.equal(labelsFor('it-IT').paste, 'Incolla');
    assert.equal(labelsFor('zh-CN').paste, '粘贴');
    assert.equal(labelsFor('fr-FR').paste, 'Paste');
    assert.equal(labelsFor(undefined).copy, 'Copy');
});
