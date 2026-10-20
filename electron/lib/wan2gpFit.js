// Which Wan2GP models fit this machine. Pure module (no electron import) so it can be unit-tested.
//
// Requirements are rough estimates for the quantized (int8) weights Wan2GP downloads by default,
// including the text encoder, for a first run on an NVIDIA GPU:
//   minVramGB     below this the model will not run (Wan2GP offloads to RAM, but not infinitely)
//   comfortVramGB at or above this it runs without heavy offloading
//   minRamGB      system RAM needed for the offloaded weights
//   downloadGB    approximate size of everything a first run downloads
const REQUIREMENTS = {
    ideogram4_nf4:         { minVramGB: 8,  comfortVramGB: 12, minRamGB: 24, downloadGB: 14 },
    krea2_turbo_kroma_v031: { minVramGB: 12, comfortVramGB: 16, minRamGB: 48, downloadGB: 34 },
    krea2_turbo:           { minVramGB: 12, comfortVramGB: 16, minRamGB: 32, downloadGB: 22 },
    flux_chroma_radiance:  { minVramGB: 8,  comfortVramGB: 12, minRamGB: 24, downloadGB: 16 },
    hidream_o1_dev_2604:   { minVramGB: 12, comfortVramGB: 16, minRamGB: 32, downloadGB: 20 },
    flux:                  { minVramGB: 8,  comfortVramGB: 12, minRamGB: 16, downloadGB: 17 },
    qwen_image_20B:        { minVramGB: 12, comfortVramGB: 24, minRamGB: 32, downloadGB: 28 },
    't2v_1.3B':            { minVramGB: 6,  comfortVramGB: 8,  minRamGB: 16, downloadGB: 10 },
    t2v_fusionix:          { minVramGB: 10, comfortVramGB: 16, minRamGB: 32, downloadGB: 20 },
    i2v_fusionix:          { minVramGB: 10, comfortVramGB: 16, minRamGB: 32, downloadGB: 20 },
    infinitetalk:          { minVramGB: 12, comfortVramGB: 20, minRamGB: 48, downloadGB: 22 },
    t2v_2_2:               { minVramGB: 12, comfortVramGB: 24, minRamGB: 48, downloadGB: 30 },
    i2v_2_2:               { minVramGB: 12, comfortVramGB: 24, minRamGB: 48, downloadGB: 30 },
    hunyuan_1_5_t2v:       { minVramGB: 12, comfortVramGB: 20, minRamGB: 32, downloadGB: 16 },
    hunyuan_1_5_480_i2v_step_distilled: { minVramGB: 10, comfortVramGB: 16, minRamGB: 32, downloadGB: 16 },
    qwen_image_21_turbo_7B: { minVramGB: 8, comfortVramGB: 12, minRamGB: 24, downloadGB: 17 },
    qwen_image_21_7B:      { minVramGB: 8, comfortVramGB: 12, minRamGB: 24, downloadGB: 17 },
    hunyuan_1_5_480_t2v:   { minVramGB: 10, comfortVramGB: 16, minRamGB: 32, downloadGB: 16 },
    ltx2_22B_distilled:    { minVramGB: 16, comfortVramGB: 24, minRamGB: 48, downloadGB: 35 },
};

// Free space we want to keep after the download finishes.
const DISK_HEADROOM_GB = 10;

const FIT_ORDER = { recommended: 0, unknown: 1, heavy: 2, unfit: 3 };

/**
 * @param {string} modelType  WanGP model_type
 * @param {{ vramGB: number|null, ramGB: number|null, freeDiskGB: number|null, gpuName?: string }} hardware
 * @param {{ needsDownload?: boolean }} [state]
 * @returns {{ fit: 'recommended'|'heavy'|'unfit'|'unknown', reason: string, downloadGB: number|null }}
 */
function rateFit(modelType, hardware, { needsDownload = false } = {}) {
    return rateAgainst(REQUIREMENTS[modelType], hardware, needsDownload);
}

// Requirements of an sd.cpp model (GGUF/safetensors checkpoint). sd.cpp keeps the weights in
// VRAM and can spill to RAM, so: weights + ~1.5 GB of compute buffers is comfortable, ~60% of that
// still runs (slower). `remainingDownloadGB` is what is still missing on disk (0 when ready).
function sdRequirements(model, auxiliaryGB = 0, remainingDownloadGB = 0) {
    const weightsGB = (model.sizeGB || 0) + auxiliaryGB;
    const neededGB = weightsGB + 1.5;
    return {
        minVramGB: Math.max(3, Math.ceil(neededGB * 0.6)),
        comfortVramGB: Math.ceil(neededGB),
        minRamGB: Math.max(8, Math.ceil(weightsGB * 2)),
        downloadGB: Math.ceil(remainingDownloadGB * 10) / 10,
    };
}

function rateAgainst(req, hardware, needsDownload) {
    if (!req || !hardware) return { fit: 'unknown', reason: '', downloadGB: null };

    const downloadGB = needsDownload ? req.downloadGB : null;
    const { vramGB, ramGB, freeDiskGB } = hardware;

    if (vramGB === null || vramGB === undefined) {
        return { fit: 'unfit', reason: 'No NVIDIA GPU detected — local video models need one.', downloadGB };
    }
    if (vramGB < req.minVramGB) {
        return { fit: 'unfit', reason: `Needs at least ${req.minVramGB} GB of GPU memory — yours has ${vramGB} GB.`, downloadGB };
    }
    if (ramGB !== null && ramGB !== undefined && ramGB < req.minRamGB) {
        return { fit: 'unfit', reason: `Needs about ${req.minRamGB} GB of system RAM — this PC has ${ramGB} GB.`, downloadGB };
    }
    if (needsDownload && freeDiskGB !== null && freeDiskGB !== undefined && freeDiskGB < req.downloadGB + DISK_HEADROOM_GB) {
        return { fit: 'unfit', reason: `Needs about ${req.downloadGB} GB of free disk for the download — only ${freeDiskGB} GB free.`, downloadGB };
    }
    if (vramGB < req.comfortVramGB) {
        return { fit: 'heavy', reason: `Runs on your ${vramGB} GB GPU but slowly (smooth from ${req.comfortVramGB} GB).`, downloadGB };
    }
    return { fit: 'recommended', reason: '', downloadGB };
}

module.exports = { REQUIREMENTS, FIT_ORDER, rateFit, rateAgainst, sdRequirements };
