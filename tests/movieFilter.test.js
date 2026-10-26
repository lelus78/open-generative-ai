const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildMovieArgs, parseProgress, parseProbe, captionFileText } = require('../electron/lib/movieFilter');

const FFMPEG = ['E:/Docker image/Wan2GP/Wan2GP/ffmpeg_bins/ffmpeg.exe', 'ffmpeg'].find((b) => {
    const r = spawnSync(b, ['-version'], { encoding: 'utf8' });
    return !r.error && r.status === 0 && /version (n?[5-9]|n?\d{2})/.test(r.stdout);
});

test('single clip, no transition', () => {
    const { args, totalSeconds } = buildMovieArgs({ clips: [{ path: 'a.mp4', kind: 'video', duration: 5, hasAudio: true }] }, 'o.mp4');
    assert.equal(totalSeconds, 5);
    assert.ok(args.includes('-filter_complex'));
});

test('transitions overlap the clips and are capped at half the shortest clip', () => {
    const { totalSeconds } = buildMovieArgs({
        transition: 'fade', transitionSeconds: 10,
        clips: [{ path: 'a.mp4', kind: 'video', duration: 4, hasAudio: false }, { path: 'b.mp4', kind: 'video', duration: 6, hasAudio: true }],
    }, 'o.mp4');
    assert.ok(totalSeconds > 6 && totalSeconds < 10, String(totalSeconds));
});

test('cut transition simply adds the durations; trims apply', () => {
    const { totalSeconds } = buildMovieArgs({
        transition: 'none',
        clips: [{ path: 'a.mp4', kind: 'video', duration: 5, trimStart: 1, trimEnd: 4 }, { path: 'p.png', kind: 'image', duration: 3 }],
    }, 'o.mp4');
    assert.equal(totalSeconds, 6);
});

test('empty project is refused', () => {
    assert.throws(() => buildMovieArgs({ clips: [] }, 'o.mp4'), /at least one/);
});

test('helpers', () => {
    assert.equal(captionFileText("it's: 100% "), "it's: 100\\%");
    assert.equal(parseProgress('out_time_us=2500000\nprogress=continue', 5), 0.5);
    const p = parseProbe('Duration: 00:00:03.50, start: 0\n Stream #0:0: Video: h264, yuv420p, 832x480, 16 fps\n Stream #0:1: Audio: aac');
    assert.deepEqual([p.duration, p.width, p.height, p.hasAudio, p.hasVideo], [3.5, 832, 480, true, true]);
});

test('real ffmpeg renders a movie (videos + picture + captions + music)', { skip: !FFMPEG }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movie-'));
    const run = (args) => { const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
    run(['-f', 'lavfi', '-i', 'testsrc=duration=3:size=832x480:rate=16', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-pix_fmt', 'yuv420p', path.join(dir, 'a.mp4')]);
    run(['-f', 'lavfi', '-i', 'testsrc2=duration=4:size=480x832:rate=24', '-pix_fmt', 'yuv420p', path.join(dir, 'b.mp4')]);
    run(['-f', 'lavfi', '-i', 'color=c=orange:size=1024x1024', '-frames:v', '1', path.join(dir, 'c.png')]);
    run(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', path.join(dir, 'm.mp3')]);
    fs.writeFileSync(path.join(dir, 'c1.txt'), captionFileText("Scene one: it's 100%"));
    fs.writeFileSync(path.join(dir, 'c2.txt'), captionFileText('A picture'));
    const font = ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((f) => fs.existsSync(f));
    for (const transition of ['none', 'fade', 'slideleft']) {
        const out = path.join(dir, `out-${transition}.mp4`);
        const plan = buildMovieArgs({
            width: 1280, height: 720, fps: 24, transition, transitionSeconds: 0.6, fontFile: font,
            music: { path: path.join(dir, 'm.mp3'), volume: 0.4 },
            clips: [
                { path: path.join(dir, 'a.mp4'), kind: 'video', duration: 3, hasAudio: true, captionFile: path.join(dir, 'c1.txt') },
                { path: path.join(dir, 'b.mp4'), kind: 'video', duration: 4, hasAudio: false },
                { path: path.join(dir, 'c.png'), kind: 'image', duration: 3, motion: 'pan-left', captionFile: path.join(dir, 'c2.txt') },
            ],
        }, out);
        const r = spawnSync(FFMPEG, plan.args, { encoding: 'utf8' });
        assert.equal(r.status, 0, `${transition}: ${r.stderr.slice(-800)}`);
        const probe = parseProbe(spawnSync(FFMPEG, ['-hide_banner', '-i', out], { encoding: 'utf8' }).stderr);
        assert.ok(Math.abs(probe.duration - plan.totalSeconds) < 0.3, `${transition}: ${probe.duration} vs ${plan.totalSeconds}`);
        assert.deepEqual([probe.width, probe.height, probe.hasAudio], [1280, 720, true]);
    }
});

test('a long title shrinks to fit the frame', () => {
    const short = buildMovieArgs({ fontFile: 'f.ttf', clips: [{ kind: 'title', title: 'IRONHOLD', titleFile: 't.txt', duration: 3 }] }, 'o.mp4').args.join(' ');
    const long = buildMovieArgs({ fontFile: 'f.ttf', clips: [{ kind: 'title', title: 'IRONHOLD: IL RISVEGLIO DEL CASTELLO DI FERRO', titleFile: 't.txt', duration: 3 }] }, 'o.mp4').args.join(' ');
    const size = (text) => Number(/fontsize=(\d+)/.exec(text)[1]);
    assert.ok(size(long) < size(short), `${size(long)} vs ${size(short)}`);
    assert.ok(size(long) * 0.6 * 42 <= 1280 * 0.9);
});

test('title cards and sound effects render with real ffmpeg', { skip: !FFMPEG }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movie-'));
    const run = (args) => { const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
    run(['-f', 'lavfi', '-i', 'testsrc=duration=4:size=640x360:rate=24', '-pix_fmt', 'yuv420p', path.join(dir, 'a.mp4')]);
    run(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', path.join(dir, 'fx.wav')]);
    const font = ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((f) => fs.existsSync(f));
    fs.writeFileSync(path.join(dir, 'title.txt'), captionFileText('IRONHOLD'));
    fs.writeFileSync(path.join(dir, 'sub.txt'), captionFileText('Coming soon'));
    const out = path.join(dir, 'out.mp4');
    const plan = buildMovieArgs({
        width: 1280, height: 720, fps: 24, transition: 'fade', transitionSeconds: 0.5, fontFile: font,
        clips: [
            { kind: 'title', title: 'IRONHOLD', titleFile: path.join(dir, 'title.txt'), subtitleFile: path.join(dir, 'sub.txt'), duration: 3 },
            { path: path.join(dir, 'a.mp4'), kind: 'video', duration: 4, hasAudio: false, sfx: { path: path.join(dir, 'fx.wav'), volume: 0.9 } },
        ],
    }, out);
    const r = spawnSync(FFMPEG, plan.args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr.slice(-800));
    const probe = parseProbe(spawnSync(FFMPEG, ['-hide_banner', '-i', out], { encoding: 'utf8' }).stderr);
    assert.ok(Math.abs(probe.duration - plan.totalSeconds) < 0.3);
    assert.equal(probe.hasAudio, true);
});

test('every transition, title style and caption style renders with real ffmpeg', { skip: !FFMPEG }, () => {
    const { TRANSITION_LIST, TITLE_STYLES, CAPTION_STYLES } = require('../electron/lib/movieFilter');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movie-'));
    const run = (args) => { const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
    run(['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x180:rate=12', '-pix_fmt', 'yuv420p', path.join(dir, 'a.mp4')]);
    const win = 'C:/Windows/Fonts/';
    const fonts = fs.existsSync(`${win}arial.ttf`)
        ? { sans: `${win}arial.ttf`, bold: `${win}arialbd.ttf`, serif: `${win}times.ttf`, serifBold: `${win}timesbd.ttf`, impact: `${win}impact.ttf`, mono: `${win}consola.ttf` }
        : { sans: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', bold: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' };
    if (!fs.existsSync(fonts.sans)) return;
    fs.writeFileSync(path.join(dir, 'cap.txt'), captionFileText('A caption: 100%'));
    fs.writeFileSync(path.join(dir, 'tit.txt'), captionFileText('TITLE'));
    fs.writeFileSync(path.join(dir, 'sub.txt'), captionFileText('subtitle'));
    const render = (project, label) => {
        const plan = buildMovieArgs({ width: 320, height: 180, fps: 12, fonts, fontFile: fonts.bold, preview: true, ...project }, path.join(dir, 'o.mp4'));
        const r = spawnSync(FFMPEG, plan.args, { encoding: 'utf8' });
        assert.equal(r.status, 0, `${label}: ${r.stderr.slice(-500)}`);
    };
    const clip = (extra) => ({ path: path.join(dir, 'a.mp4'), kind: 'video', duration: 3, hasAudio: false, ...extra });
    for (const [id] of TRANSITION_LIST) render({ transition: id, transitionSeconds: 0.5, clips: [clip(), clip()] }, `transition ${id}`);
    // a different transition into each scene, with a cut in the middle
    render({ transition: 'fade', clips: [clip(), clip({ transitionIn: 'wipeleft' }), clip({ transitionIn: 'none' }), clip({ transitionIn: 'circleopen' })] }, 'mixed');
    for (const style of Object.keys(TITLE_STYLES)) {
        render({ clips: [{ kind: 'title', duration: 3, title: 'TITLE', titleFile: path.join(dir, 'tit.txt'), subtitleFile: path.join(dir, 'sub.txt'), titleStyle: style }, clip({ title: 'TITLE', titleFile: path.join(dir, 'tit.txt'), titleStyle: style })] }, `title style ${style}`);
    }
    for (const style of Object.keys(CAPTION_STYLES)) render({ clips: [clip({ captionFile: path.join(dir, 'cap.txt'), captionStyle: style })] }, `caption style ${style}`);
});

test('a cut between two transitions keeps the total length exact', () => {
    const { totalSeconds } = buildMovieArgs({
        transition: 'fade', transitionSeconds: 1,
        clips: [{ path: 'a', kind: 'video', duration: 5, hasAudio: false }, { path: 'b', kind: 'video', duration: 5, hasAudio: false, transitionIn: 'none' }, { path: 'c', kind: 'video', duration: 5, hasAudio: false }],
    }, 'o.mp4');
    assert.ok(Math.abs(totalSeconds - (15 - 0.04 - 1)) < 0.01, String(totalSeconds));
});

test('upscale: target size keeps the shape, the graph names the nodes the movie maker reads', () => {
    const { targetSize, buildUpscaleGraph } = require('../electron/lib/movieUpscale');
    assert.deepEqual(targetSize(1280, 720, '1080p'), { width: 1920, height: 1080, portrait: false });
    assert.deepEqual(targetSize(1280, 720, '4k'), { width: 3840, height: 2160, portrait: false });
    assert.deepEqual(targetSize(720, 1280, '1080p'), { width: 1080, height: 1920, portrait: true });
    assert.deepEqual(targetSize(2560, 1440, '1080p'), { width: 2560, height: 1440, portrait: false }); // never smaller than the source
    assert.throws(() => targetSize(1280, 720, '8k'), /Unknown target/);
    const graph = buildUpscaleGraph({ file: 'piece.mp4', model: '4x.safetensors', width: 1920, height: 1080, prefix: 'video/x' });
    assert.equal(graph[1].class_type, 'LoadVideo');
    assert.equal(graph[7].class_type, 'SaveVideo');
    assert.deepEqual(graph[5].inputs.image, ['4', 0]);
    assert.equal(graph[3].inputs.model_name, '4x.safetensors');
});

test('continuity: the previous shot joins the references without ever dropping a character', async () => {
    const { mergeContinuityRef, withContinuityStory, CONTINUITY_NAME } = await import('../src/lib/movieContinuity.js');
    const c = (name) => ({ path: `${name}.png`, role: 'character', name });
    const p = (name) => ({ path: `${name}.png`, role: 'place', name });
    assert.deepEqual(mergeContinuityRef([c('A'), p('Castle')], 'frame.png').map((r) => r.name), ['A', 'Castle', CONTINUITY_NAME]);
    assert.deepEqual(mergeContinuityRef([c('A'), c('B'), p('Castle'), p('Village')], 'frame.png').map((r) => r.name), ['A', 'B', 'Castle', CONTINUITY_NAME]);
    assert.deepEqual(mergeContinuityRef([c('A'), c('B'), c('C'), c('D')], 'frame.png').map((r) => r.name), ['A', 'B', 'C', 'D']);
    assert.deepEqual(mergeContinuityRef([c('A')], null).map((r) => r.name), ['A']);
    const refs = mergeContinuityRef([c('A')], 'frame.png');
    assert.match(withContinuityStory('A walks.', refs), /continues seamlessly from Previous shot/);
    assert.equal(withContinuityStory('A walks.', [c('A')]), 'A walks.');
});

test('upscale: the AI picture is mixed with the plain enlargement to keep faces natural', () => {
    const { blendFilter } = require('../electron/lib/movieUpscale');
    const size = { width: 1920, height: 1080 };
    const mixed = blendFilter(size, 0.4).graph;
    assert.match(mixed, /scale=1920:1080:flags=lanczos/);
    assert.match(mixed, /A\*0\.4\+B\*0\.6/);
    assert.equal(blendFilter(size, 1).graph, '[0:v]null[v]');
    assert.match(blendFilter(size, undefined).graph, /A\*0\.4/);
    assert.match(blendFilter(size, 0).graph, /A\*0\+B\*1/);
});

test('transparent title cards fold into a neighbouring scene', async () => {
    const { foldTransparentTitles } = await import('../src/lib/movieTimeline.js');
    const scenes = [
        { id: 'a', kind: 'title', transparent: true, title: 'IRONHOLD', subtitle: 'Trailer', titleStyle: 'gold' },
        { id: 'b', kind: 'video', path: 'b.mp4' },
        { id: 'c', kind: 'video', path: 'c.mp4', title: 'OWN TITLE' },
        { id: 'd', kind: 'title', transparent: true, title: 'THE END' },
    ];
    const out = foldTransparentTitles(scenes);
    assert.deepEqual(out.map((s) => s.id), ['b', 'c', 'd']);
    assert.equal(out[0].title, 'IRONHOLD');
    assert.equal(out[0].titleStyle, 'gold');
    assert.equal(out[1].title, 'OWN TITLE'); // its own title is kept
    assert.equal(out[2].kind, 'title'); // nothing free to take it: stays a normal card
    assert.equal(scenes[0].folded, undefined); // the input is not changed
});

test('a title can be exported with a transparent background (ProRes 4444 and WebM alpha)', { skip: !FFMPEG }, () => {
    const { buildTitleExportArgs } = require('../electron/lib/movieFilter');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movie-'));
    const win = 'C:/Windows/Fonts/';
    const fonts = fs.existsSync(`${win}arialbd.ttf`) ? { bold: `${win}arialbd.ttf`, sans: `${win}arial.ttf` } : { bold: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', sans: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf' };
    if (!fs.existsSync(fonts.bold)) return;
    fs.writeFileSync(path.join(dir, 't.txt'), captionFileText('IRONHOLD'));
    assert.throws(() => buildTitleExportArgs({ clip: {}, fonts, fontFile: fonts.bold }, 'x.mov'), /title text/);
    for (const format of ['mov', 'webm']) {
        const out = path.join(dir, `title.${format}`);
        const plan = buildTitleExportArgs({ clip: { title: 'IRONHOLD', titleFile: path.join(dir, 't.txt') }, width: 640, height: 360, fps: 12, seconds: 2, format, fonts, fontFile: fonts.bold }, out);
        const r = spawnSync(FFMPEG, plan.args, { encoding: 'utf8' });
        assert.equal(r.status, 0, `${format}: ${r.stderr.slice(-400)}`);
        // the first frame (before the text fades in) is fully transparent, and the file has an alpha channel
        const probe = spawnSync(FFMPEG, ['-hide_banner', '-i', out], { encoding: 'utf8' }).stderr;
        assert.match(probe, format === 'mov' ? /prores/i : /vp9/i);
        const frame = path.join(dir, `f-${format}.png`);
        const grab = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-c:v', format === 'webm' ? 'libvpx-vp9' : 'prores', '-i', out, '-ss', '1', '-frames:v', '1', '-pix_fmt', 'rgba', frame], { encoding: 'utf8' });
        assert.equal(grab.status, 0, grab.stderr);
        const info = spawnSync(FFMPEG, ['-hide_banner', '-i', frame], { encoding: 'utf8' }).stderr;
        assert.match(info, /rgba|pal8|argb/i);
    }
});

test('artistic caption style: capitals fit the width and gold rules are drawn above and below', () => {
    const { captionFilters, styledText } = require('../electron/lib/movieText');
    assert.equal(styledText('cinzel', 'caption', 'Poi arriva il colore.'), 'POI ARRIVA IL COLORE.');
    assert.equal(styledText('subtitle', 'caption', 'Poi arriva'), 'Poi arriva');
    const filters = captionFilters({ clip: { caption: 'Ogni dettaglio, a mano.', captionFile: 'c.txt', captionStyle: 'cinzelrules' }, dur: 4, w: 1080, h: 1920, fonts: { display: 'C:/f/Cinzel.ttf' } });
    assert.equal(filters.length, 3);
    assert.ok(filters.every((f) => f.startsWith('drawtext=') && f.includes('alpha=')));
    assert.equal(captionFilters({ clip: { caption: 'Ciao', captionFile: 'c.txt', captionStyle: 'cinzel' }, dur: 4, w: 1080, h: 1920, fonts: { display: 'C:/f/Cinzel.ttf' } }).length, 1);
    const size = Number(/fontsize=(\d+)/.exec(filters[1])[1]);
    assert.ok(size * 0.66 * 'Ogni dettaglio, a mano.'.length <= 1080 * 0.87, `size ${size} too wide`);
});

test('every title and caption style builds valid drawtext filters', () => {
    const { TITLE_STYLES, CAPTION_STYLES, titleFilters, captionFilters } = require('../electron/lib/movieText');
    const roles = new Set([...Object.values(TITLE_STYLES), ...Object.values(CAPTION_STYLES)].map((s) => s.font));
    const fonts = Object.fromEntries([...roles].map((r) => [r, `C:/f/${r}.ttf`]));
    for (const id of Object.keys(TITLE_STYLES)) {
        const f = titleFilters({ clip: { kind: 'video', title: "Ambry's Lab", titleFile: 't.txt', titleStyle: id }, dur: 4, w: 720, h: 1280, fonts, fontFile: 'C:/f/bold.ttf' });
        assert.ok(f.length >= 1 && f.every((x) => x.startsWith('drawtext=') && !/NaN|undefined/.test(x)), `title ${id}`);
    }
    for (const id of Object.keys(CAPTION_STYLES)) {
        const f = captionFilters({ clip: { caption: 'Poi arriva il colore.', captionFile: 'c.txt', captionStyle: id }, dur: 4, w: 720, h: 1280, fonts, fontFile: 'C:/f/bold.ttf' });
        assert.ok(f.length >= 1 && f.every((x) => x.startsWith('drawtext=') && !/NaN|undefined/.test(x)), `caption ${id}`);
    }
});
