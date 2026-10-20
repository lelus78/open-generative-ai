// One-click Wan2GP install from the app: no git, Python or conda needed on the machine.
//   1. `uv` (single static binary) is downloaded; it provides Python 3.11 and the venv
//   2. Wan2GP's source is downloaded as a zip from GitHub
//   3. PyTorch (CUDA build picked from the NVIDIA driver) + Wan2GP requirements go in <dir>/venv
// Model weights are still fetched by Wan2GP itself the first time each model runs.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const UV_ASSETS = {
    'win32-x64': 'uv-x86_64-pc-windows-msvc.zip',
    'linux-x64': 'uv-x86_64-unknown-linux-gnu.tar.gz',
};
const UV_BASE_URL = 'https://github.com/astral-sh/uv/releases/latest/download/';
const WAN2GP_ZIP_URL = 'https://github.com/deepbeepmeep/Wan2GP/archive/refs/heads/main.zip';
const TOTAL_STEPS = 6;

let installing = false;

function run(cmd, args, { env, cwd, onLine } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { env: { ...process.env, ...env }, cwd, windowsHide: true });
        const tail = [];
        const onData = (data) => {
            for (const raw of data.toString().split(/\r?\n|\r/)) {
                const line = raw.trim();
                if (!line) continue;
                tail.push(line);
                if (tail.length > 30) tail.shift();
                onLine?.(line);
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve(tail);
            else reject(new Error(`${path.basename(cmd)} exited with code ${code}\n${tail.slice(-8).join('\n')}`));
        });
    });
}

function findFile(dir, name) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === name) return full;
        if (entry.isDirectory()) {
            const found = findFile(full, name);
            if (found) return found;
        }
    }
    return null;
}

// `tar` ships with Windows 10+ (bsdtar) and reads zip files too.
const extractArchive = (archive, dest) => {
    fs.mkdirSync(dest, { recursive: true });
    return run('tar', ['-xf', archive, '-C', dest]);
};

async function detectTorchBuild() {
    let out;
    try {
        out = await run('nvidia-smi', ['--query-gpu=driver_version', '--format=csv,noheader']);
    } catch {
        throw new Error('No NVIDIA GPU/driver found (nvidia-smi is missing). Local Wan2GP video needs an NVIDIA GPU.');
    }
    const driver = out[0] || '';
    const major = parseInt(driver.split('.')[0], 10);
    if (Number.isFinite(major) && major >= 580) {
        return { driver, packages: ['torch==2.10.0', 'torchvision==0.25.0', 'torchaudio==2.10.0'], index: 'https://download.pytorch.org/whl/cu130' };
    }
    // Older drivers cannot run the CUDA 13 build.
    return { driver, packages: ['torch==2.7.1', 'torchvision==0.22.1', 'torchaudio==2.7.1'], index: 'https://download.pytorch.org/whl/cu128' };
}

/**
 * @param {{ dataDir: string, dir?: string, downloadFile: Function, send: Function }} opts
 * @returns {Promise<{ dir: string }>}
 */
async function installWan2gp({ dataDir, dir, downloadFile, send }) {
    if (installing) throw new Error('Wan2GP installation is already running.');
    installing = true;
    try {
        const step = (n, message) => send({ phase: 'installing', step: n, totalSteps: TOTAL_STEPS, message: `Step ${n}/${TOTAL_STEPS} — ${message}` });
        const detail = (n, text) => send({ phase: 'installing', step: n, totalSteps: TOTAL_STEPS, message: `Step ${n}/${TOTAL_STEPS} — ${text.slice(0, 110)}` });

        const platformKey = `${process.platform}-${process.arch}`;
        const uvAsset = UV_ASSETS[platformKey];
        if (!uvAsset) throw new Error(`Automatic Wan2GP install is not supported on ${platformKey}. Install Wan2GP manually and set its folder.`);

        const installDir = path.resolve(dir || path.join(dataDir, 'wan2gp-engine'));
        const toolsDir = path.join(dataDir, 'tools');
        fs.mkdirSync(toolsDir, { recursive: true });

        step(1, 'checking NVIDIA GPU');
        const torch = await detectTorchBuild();

        step(2, 'downloading installer tool (uv)');
        let uvPath = findFile(path.join(toolsDir, 'uv'), process.platform === 'win32' ? 'uv.exe' : 'uv');
        if (!uvPath) {
            const archive = path.join(toolsDir, uvAsset);
            await downloadFile(UV_BASE_URL + uvAsset, archive);
            await extractArchive(archive, path.join(toolsDir, 'uv'));
            fs.unlinkSync(archive);
            uvPath = findFile(path.join(toolsDir, 'uv'), process.platform === 'win32' ? 'uv.exe' : 'uv');
            if (!uvPath) throw new Error('uv was downloaded but its executable was not found.');
            if (process.platform !== 'win32') fs.chmodSync(uvPath, 0o755);
        }
        const uvEnv = {
            UV_CACHE_DIR: path.join(toolsDir, 'uv-cache'),
            UV_PYTHON_INSTALL_DIR: path.join(toolsDir, 'python'),
            UV_LINK_MODE: 'copy',
            UV_NO_PROGRESS: '1',
        };

        step(3, 'downloading Wan2GP');
        if (fs.existsSync(path.join(installDir, 'wgp.py'))) {
            detail(3, 'Wan2GP folder already present — reusing it');
        } else {
            const zipPath = path.join(toolsDir, 'wan2gp-main.zip');
            const unpackDir = path.join(toolsDir, 'wan2gp-unpack');
            fs.rmSync(unpackDir, { recursive: true, force: true });
            await downloadFile(WAN2GP_ZIP_URL, zipPath);
            await extractArchive(zipPath, unpackDir);
            const inner = fs.readdirSync(unpackDir).map(n => path.join(unpackDir, n)).find(p => fs.statSync(p).isDirectory());
            if (!inner || !fs.existsSync(path.join(inner, 'wgp.py'))) throw new Error('The Wan2GP download looks incomplete (wgp.py missing).');
            fs.mkdirSync(path.dirname(installDir), { recursive: true });
            fs.cpSync(inner, installDir, { recursive: true });
            fs.rmSync(unpackDir, { recursive: true, force: true });
            fs.unlinkSync(zipPath);
        }

        step(4, 'creating Python 3.11 environment');
        const venvDir = path.join(installDir, 'venv');
        const venvPython = process.platform === 'win32'
            ? path.join(venvDir, 'Scripts', 'python.exe')
            : path.join(venvDir, 'bin', 'python');
        if (!fs.existsSync(venvPython)) {
            await run(uvPath, ['venv', '--python', '3.11', '--seed', venvDir], { env: uvEnv, onLine: (l) => detail(4, l) });
        }

        step(5, `installing PyTorch (GPU driver ${torch.driver}) — several GB, please wait`);
        await run(uvPath, ['pip', 'install', '--python', venvPython, ...torch.packages, '--index-url', torch.index],
            { env: uvEnv, onLine: (l) => detail(5, l) });

        step(6, 'installing Wan2GP requirements');
        await run(uvPath, ['pip', 'install', '--python', venvPython, '-r', path.join(installDir, 'requirements.txt')],
            { env: uvEnv, cwd: installDir, onLine: (l) => detail(6, l) });

        detail(6, 'verifying GPU access');
        await run(venvPython, ['-c', 'import torch; raise SystemExit(0 if torch.cuda.is_available() else 3)'])
            .catch(() => { throw new Error('PyTorch was installed but cannot see the GPU. Update the NVIDIA driver and retry.'); });

        return { dir: installDir };
    } finally {
        installing = false;
    }
}

module.exports = { installWan2gp };
