// Wan2GP model catalog + settings builder.
// `modelType` is the real WanGP model_type: the basename of <Wan2GP>/defaults/<modelType>.json.
// Pure module (no electron import) so it can be unit-tested with node:test.

const RES_480P = { '16:9': '832x480', '9:16': '480x832', '1:1': '720x720', '4:3': '832x624', '3:4': '624x832' };
const RES_720P = { '16:9': '1280x720', '9:16': '720x1280', '1:1': '960x960', '4:3': '1104x832', '3:4': '832x1104' };
const RES_IMAGE = { '1:1': '1024x1024', '16:9': '1280x720', '9:16': '720x1280', '4:3': '1104x832', '3:4': '832x1104' };

const WAN2GP_CATALOG = [
    {
        id: 'wan2gp:flux-dev',
        name: 'Flux.1 Dev (Wan2GP)',
        description: 'Image — FLUX.1 dev (12B) served by Wan2GP.',
        type: 'image',
        family: 'flux',
        provider: 'wan2gp',
        modelType: 'flux',
        resolutions: RES_IMAGE,
        aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
        tags: ['image', 'flux'],
    },
    {
        id: 'wan2gp:qwen-image',
        name: 'Qwen Image (Wan2GP)',
        description: 'Image — Qwen-Image 20B text-to-image served by Wan2GP.',
        type: 'image',
        family: 'qwen',
        provider: 'wan2gp',
        modelType: 'qwen_image_20B',
        resolutions: RES_IMAGE,
        aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
        tags: ['image', 'qwen'],
    },
    {
        id: 'wan2gp:qwen-image-21-turbo',
        name: 'Qwen Image 2.1 Turbo 7B (Wan2GP)',
        description: 'Image — Qwen Image 2.1 distilled to 8 steps, 7B. Fast, and can edit with up to 10 reference images.',
        type: 'image',
        family: 'qwen',
        provider: 'wan2gp',
        modelType: 'qwen_image_21_turbo_7B',
        resolutions: RES_IMAGE,
        aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
        tags: ['image', 'qwen', 'fast'],
    },
    {
        id: 'wan2gp:qwen-image-21',
        name: 'Qwen Image 2.1 7B (Wan2GP)',
        description: 'Image — Qwen Image 2.1 7B, higher quality than Turbo but slower. Text-to-image and reference editing.',
        type: 'image',
        family: 'qwen',
        provider: 'wan2gp',
        modelType: 'qwen_image_21_7B',
        resolutions: RES_IMAGE,
        aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
        tags: ['image', 'qwen'],
    },
    {
        id: 'wan2gp:ideogram-v4',
        name: 'Ideogram v4 NF4 9.3B (Wan2GP)',
        description: 'Image — Ideogram v4: typography, layout and graphic design with readable text. Small NF4 version (needs bitsandbytes).',
        type: 'image',
        family: 'ideogram',
        provider: 'wan2gp',
        modelType: 'ideogram4_nf4',
        resolutions: RES_IMAGE,
        aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
        tags: ['image', 'ideogram', 'text'],
    },
    {
        id: 'wan2gp:krea-2-turbo',
        name: 'Krea 2 Turbo (Wan2GP)',
        description: 'Image — Krea 2 distilled to 8 steps: its authors call it the most aesthetic open image model.',
        type: 'image',
        family: 'krea',
        provider: 'wan2gp',
        modelType: 'krea2_turbo',
        resolutions: RES_IMAGE,
        aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
        tags: ['image', 'krea', 'fast'],
    },
    {
        id: 'wan2gp:chroma-radiance',
        legacy: true,
        name: 'Chroma Radiance 8.9B (Wan2GP)',
        description: 'Image — Flux 1 Chroma Radiance (Oct 2025), uncensored base model with a neutral, flexible style.',
        type: 'image',
        family: 'chroma',
        provider: 'wan2gp',
        modelType: 'flux_chroma_radiance',
        resolutions: RES_IMAGE,
        aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
        tags: ['image', 'chroma'],
    },
    {
        id: 'wan2gp:hidream-o1',
        name: 'HiDream O1 Dev 2604 10B (Wan2GP)',
        description: 'Image — HiDream O1 Dev (28 steps): text-to-image and image-reference generation.',
        type: 'image',
        family: 'hidream',
        provider: 'wan2gp',
        modelType: 'hidream_o1_dev_2604',
        resolutions: RES_IMAGE,
        aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
        tags: ['image', 'hidream'],
    },
    {
        id: 'wan2gp:kroma-v031',
        name: 'Kroma v0.3.1 Turbo (Wan2GP)',
        description: 'Image — Kroma (lodestones), a Krea 2 finetune distilled for Turbo speed (8-12 steps). Large download, quantized on the fly. Content may be unfiltered.',
        type: 'image',
        family: 'krea',
        provider: 'wan2gp',
        modelType: 'krea2_turbo_kroma_v031',
        resolutions: RES_IMAGE,
        aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
        tags: ['image', 'krea', 'kroma', 'fast'],
    },
    {
        id: 'wan2gp:kroma-edit',
        name: 'Kroma Edit — change an image with a prompt (Wan2GP)',
        description: 'Image edit — Kroma + Krea 2 General Edit v2: recolor, relight, change the background or add objects while keeping the rest of the picture. Reuses the Kroma download.',
        type: 'image',
        edit: true,
        family: 'krea',
        provider: 'wan2gp',
        modelType: 'krea2_turbo_kroma_edit_v031',
        resolutions: RES_IMAGE,
        aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
        tags: ['image', 'edit', 'krea', 'kroma'],
    },
    {
        id: 'wan2gp:krea-2-edit',
        name: 'Krea 2 Turbo Edit General v2 (Wan2GP)',
        description: 'Image edit — Krea 2 Turbo with the General Edit v2 LoRA: recolor, relight, restyle or add objects while preserving the rest of the picture.',
        type: 'image',
        edit: true,
        family: 'krea',
        provider: 'wan2gp',
        modelType: 'krea2_turbo_general_edit_v2',
        resolutions: RES_IMAGE,
        aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
        tags: ['image', 'edit', 'krea'],
    },
    {
        id: 'wan2gp:wan21-t2v-1.3b',
        name: 'Wan 2.1 1.3B (Text-to-Video)',
        description: 'Video — lightest Wan model, 480p. Runs on ~8 GB VRAM; a 5 s clip takes a few minutes.',
        type: 'video',
        family: 'wan',
        provider: 'wan2gp',
        modelType: 't2v_1.3B',
        resolutions: RES_480P,
        aspectRatios: ['16:9', '9:16', '1:1'],
        tags: ['video', 'wan', 'text-to-video', 'fast'],
    },
    {
        id: 'wan2gp:wan21-fusionix-t2v',
        name: 'Wan 2.1 FusioniX 14B (Text-to-Video)',
        description: 'Video — merged Wan 2.1 14B, sharper and faster than the original (fewer steps), 480p. Good quality/speed balance for 16 GB GPUs.',
        type: 'video',
        family: 'wan',
        provider: 'wan2gp',
        modelType: 't2v_fusionix',
        resolutions: RES_480P,
        aspectRatios: ['16:9', '9:16', '1:1'],
        tags: ['video', 'wan', 'text-to-video', 'fusionix'],
    },
    {
        id: 'wan2gp:wan21-fusionix-i2v',
        name: 'Wan 2.1 FusioniX 14B (Image-to-Video)',
        description: 'Video — FusioniX image-to-video, 480p. Provide a start frame.',
        type: 'video',
        family: 'wan',
        provider: 'wan2gp',
        modelType: 'i2v_fusionix',
        needsImage: true,
        resolutions: RES_480P,
        aspectRatios: ['16:9', '9:16', '1:1'],
        tags: ['video', 'wan', 'image-to-video', 'fusionix'],
    },
    {
        id: 'wan2gp:wan22-t2v',
        name: 'Wan 2.2 14B (Text-to-Video)',
        description: 'Video — Wan 2.2 text-to-video, 480p. Slow on consumer GPUs.',
        type: 'video',
        family: 'wan',
        provider: 'wan2gp',
        modelType: 't2v_2_2',
        resolutions: RES_480P,
        aspectRatios: ['16:9', '9:16', '1:1'],
        tags: ['video', 'wan', 'text-to-video'],
    },
    {
        id: 'wan2gp:wan22-i2v',
        name: 'Wan 2.2 14B (Image-to-Video)',
        description: 'Video — Wan 2.2 image-to-video, 480p. Provide a start frame.',
        type: 'video',
        family: 'wan',
        provider: 'wan2gp',
        modelType: 'i2v_2_2',
        needsImage: true,
        resolutions: RES_480P,
        aspectRatios: ['16:9', '9:16', '1:1'],
        tags: ['video', 'wan', 'image-to-video'],
    },
    {
        id: 'wan2gp:hunyuan-video',
        name: 'Hunyuan Video 1.5 (Wan2GP)',
        description: 'Video — Hunyuan Video 1.5 text-to-video, 480p.',
        type: 'video',
        family: 'hunyuan',
        provider: 'wan2gp',
        modelType: 'hunyuan_1_5_480_t2v',
        resolutions: RES_480P,
        aspectRatios: ['16:9', '9:16', '1:1'],
        tags: ['video', 'hunyuan'],
    },
    {
        id: 'wan2gp:hunyuan-video-720p',
        name: 'Hunyuan Video 1.5 720p (Text-to-Video)',
        description: 'Video — Hunyuan Video 1.5 8.3B text-to-video at 720p. Sharper than the 480p version, needs more GPU memory.',
        type: 'video',
        family: 'hunyuan',
        provider: 'wan2gp',
        modelType: 'hunyuan_1_5_t2v',
        resolutions: RES_720P,
        aspectRatios: ['16:9', '9:16', '1:1'],
        tags: ['video', 'hunyuan', 'text-to-video'],
    },
    {
        id: 'wan2gp:hunyuan-video-i2v',
        name: 'Hunyuan Video 1.5 (Image-to-Video)',
        description: 'Video — Hunyuan Video 1.5 image-to-video, 480p, step-distilled for speed. Provide a start frame.',
        type: 'video',
        family: 'hunyuan',
        provider: 'wan2gp',
        modelType: 'hunyuan_1_5_480_i2v_step_distilled',
        needsImage: true,
        resolutions: RES_480P,
        aspectRatios: ['16:9', '9:16', '1:1'],
        tags: ['video', 'hunyuan', 'image-to-video', 'fast'],
    },
    {
        id: 'wan2gp:infinitetalk',
        name: 'InfiniteTalk (Portrait + Audio)',
        description: 'Lip sync — makes a portrait speak your audio file (480p). Any audio length. Heavy 14B model, expect long renders.',
        type: 'video',
        family: 'wan',
        provider: 'wan2gp',
        modelType: 'infinitetalk',
        needsImage: true,
        needsAudio: true,
        lipsync: true,
        resolutions: RES_480P,
        aspectRatios: ['16:9', '9:16', '1:1'],
        tags: ['video', 'lipsync', 'audio-to-video'],
    },
    {
        id: 'wan2gp:ltx-video',
        name: 'LTX-2 Distilled (Wan2GP)',
        description: 'Video — LTX-2 distilled, 8 steps, 720p. Fastest large video model in Wan2GP.',
        type: 'video',
        family: 'ltx',
        provider: 'wan2gp',
        modelType: 'ltx2_22B_distilled',
        resolutions: RES_720P,
        aspectRatios: ['16:9', '9:16', '1:1'],
        tags: ['video', 'ltx', 'fast'],
    },
    // ── Audio: soundtrack and sound effects for the Movie studio ─────────────────
    {
        id: 'wan2gp:stable-audio3-music',
        name: 'Stable Audio 3 Small — Music',
        description: 'Audio — instrumental music, loops and grooves up to 120 s from a text description (genre, tempo, instruments, mood).',
        type: 'audio',
        audioKind: 'music',
        family: 'stable-audio',
        provider: 'wan2gp',
        modelType: 'stable_audio3_small',
        maxSeconds: 120,
        aspectRatios: [],
        tags: ['audio', 'music'],
    },
    {
        id: 'wan2gp:stable-audio3-sfx',
        name: 'Stable Audio 3 Small — Sound effects',
        description: 'Audio — impacts, whooshes, ambience, foley and transitions up to 120 s from a text description.',
        type: 'audio',
        audioKind: 'sfx',
        family: 'stable-audio',
        provider: 'wan2gp',
        modelType: 'stable_audio3_small_sfx',
        maxSeconds: 120,
        aspectRatios: [],
        tags: ['audio', 'sfx'],
    },
];

function getModelById(id) {
    return WAN2GP_CATALOG.find(m => m.id === id) || null;
}

// The model's table covers its own aspect ratios; for any other "w:h" (e.g. Cinema's 21:9 or 4:5)
// keep the short side of its square size and cap the long side, in multiples of 16.
function resolutionFor(model, aspectRatio) {
    const known = model.resolutions?.[aspectRatio];
    if (known) return known;
    const fallback = model.resolutions?.[model.aspectRatios?.[0]];
    const ratio = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(String(aspectRatio || '').trim());
    const square = model.resolutions?.['1:1'] || fallback;
    if (!ratio || !square) return fallback;
    const rw = Number(ratio[1]);
    const rh = Number(ratio[2]);
    if (!(rw > 0 && rh > 0)) return fallback;
    const base = Math.min(...square.split('x').map(Number));
    const snap = (v) => Math.max(256, Math.round(v / 16) * 16);
    const long = snap(Math.min(base * Math.max(rw, rh) / Math.min(rw, rh), base * 1.75));
    return rw >= rh ? `${long}x${base}` : `${base}x${long}`;
}

// Wan2GP trims audio-driven clips to the audio length; this only caps very long recordings (~40 s at 25 fps).
const MAX_AUDIO_DRIVEN_FRAMES = 1000;
const DEFAULT_LIPSYNC_PROMPT = 'A person speaking naturally to the camera, with expressive lip sync.';

function toInt(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : null;
}

// Build the settings object passed to `wgp.py --process` (local) or `wangp_generate` (MCP).
// Only fields the user actually chose are set; everything else falls back to the
// model's own defaults in Wan2GP, which are tuned per model (distilled models use
// few steps, LTX has its own frame count, etc.).
function buildWan2gpSettings(model, params = {}, { imageStart, audioStart } = {}) {
    if (!model?.modelType) throw new Error('Unknown Wan2GP model');
    if (model.needsImage && !imageStart) {
        throw new Error(`${model.name} requires a start-frame image — upload one first.`);
    }
    if (model.edit && !imageStart) {
        throw new Error(`${model.name} edits an existing picture — upload one first.`);
    }
    if (model.needsAudio && !audioStart) {
        throw new Error(`${model.name} requires an audio file — upload one first.`);
    }

    const settings = {
        model_type: model.modelType,
        // Wan2GP rejects an empty prompt; lip sync users usually only provide a portrait and audio.
        prompt: params.prompt || (model.lipsync ? DEFAULT_LIPSYNC_PROMPT : ''),
    };
    if (params.negative_prompt) settings.negative_prompt = params.negative_prompt;

    const resolution = model.type === 'audio' ? null : resolutionFor(model, params.aspect_ratio);
    if (resolution) settings.resolution = resolution;
    if (model.type === 'audio') {
        // Audio models take a length in seconds, not frames.
        const seconds = Number(params.duration_seconds);
        const max = model.maxSeconds || 120;
        settings.duration_seconds = Math.max(2, Math.min(max, Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 10));
    }

    const steps = toInt(params.steps);
    if (steps && steps > 0) settings.num_inference_steps = steps;

    const frames = toInt(params.video_length);
    if (model.type === 'video' && frames && frames > 0) settings.video_length = frames;

    const seed = toInt(params.seed);
    settings.seed = seed !== null && seed >= 0 ? seed : Math.floor(Math.random() * 2147483647);

    if (model.edit) {
        // Edit models take the picture as a reference image and the prompt as the instruction.
        settings.video_prompt_type = 'KI';
        settings.image_refs = [imageStart];
    } else if (imageStart) {
        settings.image_start = imageStart;
    }

    if (audioStart) {
        // Audio-driven (lip sync) models: the portrait is both the first frame and the identity
        // reference, and the clip lasts as long as the audio (video_length is only an upper bound).
        settings.audio_guide = audioStart;
        settings.audio_prompt_type = 'A';
        if (model.lipsync) {
            settings.image_prompt_type = 'S';
            settings.image_refs = [imageStart];
            settings.video_length = MAX_AUDIO_DRIVEN_FRAMES;
        }
    }
    return settings;
}

module.exports = { WAN2GP_CATALOG, getModelById, buildWan2gpSettings };
