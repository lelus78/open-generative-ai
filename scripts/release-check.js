#!/usr/bin/env node
// Checks the Windows installer in release/ before it is published. Run it after `npm run electron:build:win`:
//   node scripts/release-check.js
// It fails (exit code 1) unless:
//   1. latest.yml names this package.json version, and its size and sha512 match the installer;
//   2. the app archive inside the installer passes 7-Zip's test (2.2.5 shipped a corrupt one: the
//      installed exe was cut at 34 MB and Windows refused to start it);
//   3. the program unpacked from the installer is identical to release/win-unpacked;
//   4. that program starts and writes "app started" with this version in the debug log.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const root = path.join(__dirname, '..');
const release = path.join(root, 'release');
const { version, build } = require(path.join(root, 'package.json'));
const exeName = `${build.productName || 'Open Generative AI'}.exe`;
const installer = path.join(release, `Open-Generative-AI-Setup-${version}.exe`);
// The full 7-Zip opens NSIS installers; the 7za bundled with electron-builder cannot.
const sevenZip = [process.env.SEVEN_ZIP, 'C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe'].find((p) => p && fs.existsSync(p));
const debugLog = path.join(process.env.APPDATA || '', 'open-generative-ai', 'local-ai', 'debug.log');

let failed = false;
const ok = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg) => { failed = true; console.log(`  FAIL  ${msg}`); };
const sha512 = (file) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
/**
 * Same content? Retried for a few seconds: right after 7-Zip writes a file, Windows (the antivirus scan) can
 * still be touching it, and the first read of a freshly unpacked exe once gave a different hash.
 */
async function sameFile(a, b) {
    if (!fs.existsSync(a) || !fs.existsSync(b) || fs.statSync(a).size !== fs.statSync(b).size) return false;
    for (let i = 0; i < 5; i++) {
        if (sha512(a) === sha512(b)) return true;
        await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
}
const sevenZ = (args) => spawnSync(sevenZip, args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });

async function main() {
    console.log(`Release check ${version}`);
    if (!fs.existsSync(installer)) { fail(`installer not found: ${installer}`); return; }
    if (!sevenZip) { fail('7-Zip not found: install it (https://www.7-zip.org) or set SEVEN_ZIP to 7z.exe'); return; }

    // 1. latest.yml (what the in-app updater downloads and verifies)
    const yml = fs.readFileSync(path.join(release, 'latest.yml'), 'utf-8');
    const field = (name) => (new RegExp(`^\\s*-?\\s*${name}: (.+)$`, 'm').exec(yml) || [])[1]?.trim().replace(/^'|'$/g, '');
    if (field('version') === version) ok(`latest.yml is for ${version}`); else fail(`latest.yml is for ${field('version')}, package.json says ${version}`);
    if (Number(field('size')) === fs.statSync(installer).size) ok('installer size matches latest.yml'); else fail('installer size differs from latest.yml');
    if (field('sha512') === sha512(installer)) ok('installer sha512 matches latest.yml'); else fail('installer sha512 differs from latest.yml');

    // 2. the archive inside the installer
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ogai-release-check-'));
    try {
        const pulled = sevenZ(['e', installer, `-o${tmp}`, '$PLUGINSDIR/app-64.7z', '-y']);
        const archive = path.join(tmp, 'app-64.7z');
        if (pulled.status !== 0 || !fs.existsSync(archive)) { fail(`could not read the app archive from the installer\n${pulled.stdout}${pulled.stderr}`); return; }
        const tested = sevenZ(['t', archive]);
        if (tested.status === 0 && /Everything is Ok/.test(tested.stdout)) ok('app archive passes 7-Zip test'); else { fail(`app archive is CORRUPT\n${tested.stdout.split('\n').filter(l => /error/i.test(l)).join('\n')}`); return; }

        // 3. unpacked program == release/win-unpacked
        const appDir = path.join(tmp, 'app');
        const unpacked = sevenZ(['x', archive, `-o${appDir}`, '-y']);
        if (unpacked.status !== 0) { fail('could not unpack the app archive'); return; }
        const builtExe = path.join(release, 'win-unpacked', exeName);
        const shippedExe = path.join(appDir, exeName);
        if (await sameFile(builtExe, shippedExe)) ok(`${exeName} in the installer is identical to win-unpacked (${Math.round(fs.statSync(shippedExe).size / 1048576)} MB)`);
        else {
            const size = (f) => (fs.existsSync(f) ? fs.statSync(f).size : 'missing');
            fail(`${exeName} in the installer differs from win-unpacked (installer: ${size(shippedExe)} bytes, build: ${size(builtExe)} bytes)`);
            return;
        }
        const builtAsar = path.join(release, 'win-unpacked', 'resources', 'app.asar');
        if (await sameFile(builtAsar, path.join(appDir, 'resources', 'app.asar'))) ok('app.asar in the installer is identical to win-unpacked'); else fail('app.asar in the installer differs from win-unpacked');

        // 4. the shipped program starts
        await startsUp(shippedExe);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
    }
}

/** Starts the program, waits for "app started" with this version in the debug log, then closes it. */
async function startsUp(exe) {
    const before = fs.existsSync(debugLog) ? fs.statSync(debugLog).size : 0;
    const child = spawn(exe, [], { detached: false, stdio: 'ignore' });
    let exited = null;
    child.on('exit', (code) => { exited = code; });
    child.on('error', (err) => { exited = err.message; });
    let started = false;
    for (let i = 0; i < 60 && exited === null && !started; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (!fs.existsSync(debugLog)) continue;
        const fd = fs.openSync(debugLog, 'r');
        const size = fs.fstatSync(fd).size;
        const buf = Buffer.alloc(Math.max(0, size - before));
        fs.readSync(fd, buf, 0, buf.length, before);
        fs.closeSync(fd);
        started = buf.toString('utf-8').split('\n').some((line) => line.includes('"message":"started"') && line.includes(`"version":"${version}"`));
    }
    if (started) ok('the installed program starts and logs this version');
    else fail(exited !== null ? `the program exited at start (${exited})` : 'the program did not log "started" within 60 s');
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1500));
}

main()
    .catch((err) => fail(err.stack || err.message))
    .finally(() => {
        console.log(failed ? '\nRELEASE CHECK FAILED: do not publish.' : '\nRelease check passed.');
        process.exitCode = failed ? 1 : 0;
    });
