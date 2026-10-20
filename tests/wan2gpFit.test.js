const test = require('node:test');
const assert = require('node:assert/strict');
const { rateFit, rateAgainst, sdRequirements } = require('../electron/lib/wan2gpFit');
const { withWan2gpAvailability } = require('../electron/lib/wan2gpModelAvailability');

const big = { vramGB: 16, ramGB: 80, freeDiskGB: 4000 };
const small = { vramGB: 6, ramGB: 16, freeDiskGB: 500 };

test('a 16 GB GPU runs Wan 2.1 1.3B comfortably and the 22B LTX-2 only heavily', () => {
    assert.equal(rateFit('t2v_1.3B', big).fit, 'recommended');
    assert.equal(rateFit('ltx2_22B_distilled', big).fit, 'heavy');
});

test('a model that needs more GPU memory than available does not fit, with a reason', () => {
    const r = rateFit('ltx2_22B_distilled', small);
    assert.equal(r.fit, 'unfit');
    assert.match(r.reason, /16 GB of GPU memory/);
});

test('not enough system RAM or free disk makes a model unfit', () => {
    assert.equal(rateFit('t2v_2_2', { vramGB: 24, ramGB: 16, freeDiskGB: 500 }).fit, 'unfit');
    const disk = rateFit('t2v_1.3B', { vramGB: 16, ramGB: 64, freeDiskGB: 12 }, { needsDownload: true });
    assert.equal(disk.fit, 'unfit');
    assert.match(disk.reason, /free disk/);
    // Already downloaded: disk space no longer matters
    assert.equal(rateFit('t2v_1.3B', { vramGB: 16, ramGB: 64, freeDiskGB: 1 }).fit, 'recommended');
});

test('unknown models and missing hardware info are not judged', () => {
    assert.equal(rateFit('some_new_model', big).fit, 'unknown');
    assert.equal(rateFit('flux', null).fit, 'unknown');
});

test('no NVIDIA GPU makes Wan2GP models unfit', () => {
    assert.equal(rateFit('flux', { vramGB: null, ramGB: 32, freeDiskGB: 100 }).fit, 'unfit');
});

test('sd.cpp requirements scale with the checkpoint size', () => {
    const sd15 = sdRequirements({ sizeGB: 2.1 });
    const sdxl = sdRequirements({ sizeGB: 6.9 });
    assert.ok(sdxl.comfortVramGB > sd15.comfortVramGB);
    assert.equal(rateAgainst(sd15, { vramGB: 4, ramGB: 16, freeDiskGB: 50 }, false).fit, 'recommended');
    assert.equal(rateAgainst(sdxl, { vramGB: 4, ramGB: 16, freeDiskGB: 50 }, false).fit, 'unfit');
});

test('withWan2gpAvailability blocks models that do not fit a local engine and annotates the rest', () => {
    const engine = (hardware, status) => ({ ok: true, mode: 'local', hardware, modelStatus: new Map([['ltx2_22B_distilled', status]]) });
    const model = { id: 'wan2gp:ltx-video', modelType: 'ltx2_22B_distilled' };

    const blocked = withWan2gpAvailability(model, engine(small, 'missing'));
    assert.equal(blocked.ready, false);
    assert.equal(blocked.fit, 'unfit');
    assert.match(blocked.unavailableReason, /GPU memory/);

    const heavy = withWan2gpAvailability(model, engine(big, 'missing'));
    assert.equal(heavy.ready, true);
    assert.equal(heavy.fit, 'heavy');
    assert.equal(heavy.needsDownload, true);
    assert.equal(heavy.downloadGB, 35);
    assert.match(heavy.availabilityNote, /~35 GB/);

    const onDisk = withWan2gpAvailability(model, engine(big, 'available'));
    assert.equal(onDisk.needsDownload, undefined);
});

test('a remote engine is never judged against this PC', () => {
    const model = { id: 'wan2gp:ltx-video', modelType: 'ltx2_22B_distilled' };
    const r = withWan2gpAvailability(model, { ok: true, mode: 'remote', hardware: { vramGB: 4, ramGB: 8, freeDiskGB: 1 }, modelStatus: new Map([['ltx2_22B_distilled', 'missing']]) });
    assert.equal(r.ready, true);
    assert.equal(r.fit, undefined);
});

test('legacy models are only demoted on GPUs with enough VRAM for newer ones', () => {
    const { shouldDemoteLegacy } = require('../electron/lib/wan2gpFit');
    const model = { id: 'wan2gp:chroma-radiance', modelType: 'flux_chroma_radiance', legacy: true };
    const status = new Map([['flux_chroma_radiance', 'installed']]);
    assert.equal(shouldDemoteLegacy(big), true);
    assert.equal(shouldDemoteLegacy(small), false);
    assert.equal(shouldDemoteLegacy(null), false);
    assert.equal(withWan2gpAvailability(model, { ok: true, mode: 'local', hardware: big, modelStatus: status }).legacyDemoted, true);
    assert.equal(withWan2gpAvailability(model, { ok: true, mode: 'local', hardware: { vramGB: 8, ramGB: 32, freeDiskGB: 500 }, modelStatus: status }).legacyDemoted, false);
});
