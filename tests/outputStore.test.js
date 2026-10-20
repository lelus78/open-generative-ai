const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../electron/lib/outputStore');

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wan2gp-outputs-'));
    const runsDir = path.join(root, 'runs');
    const inputsDir = path.join(root, 'inputs');
    fs.mkdirSync(path.join(runsDir, '111', 'out'), { recursive: true });
    fs.mkdirSync(path.join(runsDir, '222', 'out'), { recursive: true });
    fs.mkdirSync(inputsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, '111', 'out', 'a.mp4'), Buffer.alloc(1000));
    fs.writeFileSync(path.join(runsDir, '111', 'settings.json'), '{}');
    fs.writeFileSync(path.join(runsDir, '222', 'out', 'b.png'), Buffer.alloc(500));
    fs.writeFileSync(path.join(inputsDir, 'face.png'), Buffer.alloc(300));
    fs.writeFileSync(path.join(root, 'precious.txt'), 'keep me');
    return { root, runsDir, inputsDir };
}

test('usage sums outputs and inputs separately', () => {
    const { runsDir, inputsDir } = fixture();
    assert.deepEqual(store.usage({ runsDir, inputsDir }), { outputsBytes: 1000 + 2 + 500, inputsBytes: 300 });
});

test('deleteRunContaining removes the whole run of a result file and leaves other runs alone', () => {
    const { runsDir } = fixture();
    const result = store.deleteRunContaining(runsDir, path.join(runsDir, '111', 'out', 'a.mp4'));
    assert.equal(result.deleted, true);
    assert.equal(fs.existsSync(path.join(runsDir, '111')), false);
    assert.equal(fs.existsSync(path.join(runsDir, '222', 'out', 'b.png')), true);
});

test('deleteRunContaining refuses paths outside the runs folder', () => {
    const { root, runsDir } = fixture();
    assert.throws(() => store.deleteRunContaining(runsDir, path.join(root, 'precious.txt')), /not one of the generated results/);
    assert.throws(() => store.deleteRunContaining(runsDir, path.join(runsDir, '..', 'precious.txt')), /not one of the generated results/);
    assert.throws(() => store.deleteRunContaining(runsDir, runsDir), /not one of the generated results/);
    assert.equal(fs.readFileSync(path.join(root, 'precious.txt'), 'utf-8'), 'keep me');
});

test('deleteRunContaining ignores a result that is already gone', () => {
    const { runsDir } = fixture();
    assert.equal(store.deleteRunContaining(runsDir, path.join(runsDir, '999', 'out', 'x.mp4')).deleted, false);
    assert.deepEqual(store.deleteRunContaining(runsDir, ''), { deleted: false }); // empty input is a no-op
});

test('clearAll empties both folders and reports the freed size', () => {
    const { runsDir, inputsDir, root } = fixture();
    const { freedBytes } = store.clearAll({ runsDir, inputsDir });
    assert.equal(freedBytes, 1802);
    assert.deepEqual(fs.readdirSync(runsDir), []);
    assert.deepEqual(fs.readdirSync(inputsDir), []);
    assert.equal(fs.existsSync(path.join(root, 'precious.txt')), true);
});
