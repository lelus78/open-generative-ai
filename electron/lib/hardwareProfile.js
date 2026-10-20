// What this machine can run: NVIDIA GPU memory, system RAM and free disk space.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const GB = 1024 ** 3;

function queryGpu() {
    return new Promise((resolve) => {
        execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
            { timeout: 8000, windowsHide: true }, (err, stdout) => {
                if (err || !stdout) return resolve(null);
                const first = stdout.trim().split(/\r?\n/)[0];
                const [name, mib] = first.split(',').map(s => s.trim());
                const memMiB = parseInt(mib, 10);
                resolve(Number.isFinite(memMiB) ? { name, vramGB: Math.round(memMiB / 1024) } : null);
            });
    });
}

function freeDiskGB(somePath) {
    // Walk up to an existing folder: the target may not have been created yet.
    let dir = somePath;
    while (dir && !fs.existsSync(dir)) {
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    try {
        const s = fs.statfsSync(dir);
        return Math.floor((s.bavail * s.bsize) / GB);
    } catch {
        return null;
    }
}

let gpuCache;

/** @param {string} [diskPath] folder whose drive should be checked for free space */
async function getHardwareProfile(diskPath) {
    if (gpuCache === undefined) gpuCache = await queryGpu();
    return {
        gpuName: gpuCache?.name || null,
        vramGB: gpuCache ? gpuCache.vramGB : null,
        ramGB: Math.round(os.totalmem() / GB),
        freeDiskGB: diskPath ? freeDiskGB(diskPath) : null,
    };
}

module.exports = { getHardwareProfile };
