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
    const now = new Date(2026, 9, 27, 10, 5, 3).getTime();
    assert.equal(defaultFileName('data:image/png;base64,AAAA', 'image', now), '2026-10-27 10-05-03 - image.png');
    assert.equal(defaultFileName('data:image/jpeg;base64,AAAA', 'image', now), '2026-10-27 10-05-03 - image.jpg');
    assert.equal(defaultFileName('https://cdn.example.com/stream', 'video', now), '2026-10-27 10-05-03 - video.mp4');
    assert.equal(defaultFileName('', 'audio', now), '2026-10-27 10-05-03 - audio.mp3');
    // a generic name inside a named run folder takes the folder's name
    assert.equal(defaultFileName('file:///E:/movies/2026-10-27%2010-49-34%20-%20reel%20discovery%20-%20Axe/movie.mp4', 'video'), '2026-10-27 10-49-34 - reel discovery - Axe.mp4');
    assert.equal(defaultFileName('file:///E:/movies/1793093987212/movie.mp4', 'video'), 'movie.mp4');
});

test('labelsFor follows the system language and falls back to English', () => {
    assert.equal(labelsFor('it-IT').paste, 'Incolla');
    assert.equal(labelsFor('zh-CN').paste, '粘贴');
    assert.equal(labelsFor('fr-FR').paste, 'Paste');
    assert.equal(labelsFor(undefined).copy, 'Copy');
});
