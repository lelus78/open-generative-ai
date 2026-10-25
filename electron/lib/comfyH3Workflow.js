// MiniMax H3 reference-to-video, expressed as a ComfyUI API graph (base pass + optional latent upscale
// and refine pass). Mirrors the community 8-step workflow. Pure module (no electron import).

const FPS = 24;
const MODEL_FILES = {
    diffusion: 'h3\\minimax_h3_ref2va_pruned_int8_convrot.safetensors',
    lora: 'h3\\minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors',
    textEncoder: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    videoVae: 'minimax_h3_video_vae_fp16.safetensors',
    audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
    upscaler: 'minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors',
};
// Where each file must live, relative to the ComfyUI folder.
const MODEL_PATHS = {
    diffusion: ['models', 'diffusion_models', 'h3', 'minimax_h3_ref2va_pruned_int8_convrot.safetensors'],
    lora: ['models', 'loras', 'h3', 'minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors'],
    textEncoder: ['models', 'text_encoders', 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'],
    videoVae: ['models', 'vae', 'minimax_h3_video_vae_fp16.safetensors'],
    audioVae: ['models', 'vae', 'minimax_h3_audio_vae_fp32.safetensors'],
    upscaler: ['models', 'latent_upscale_models', 'minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors'],
};

const MAX_REFERENCES = 4;
const NODE_BASE_SAMPLER = '12';
const NODE_REFINE_SAMPLER = '33';
const NODE_SAVE = '16';

/** H3 needs a frame count the video VAE can use: at least 5, and (n - 5) divisible by 17. */
function framesForSeconds(seconds) {
    const frames = Math.max(5, Math.round(seconds * FPS));
    return frames + (5 - (frames % 17) + 17) % 17;
}

/** Width/height for a megapixel budget at the given aspect ratio, rounded to a multiple of 32. */
function sizeForMegapixels(megapixels, aspect = 16 / 9, multiple = 32) {
    const height = Math.sqrt((megapixels * 1e6) / aspect);
    const snap = (value) => Math.max(multiple, Math.round(value / multiple) * multiple);
    return { width: snap(height * aspect), height: snap(height) };
}

/**
 * @param {object} o
 * @param {string} o.prompt         full structured H3 prompt
 * @param {string[]} o.images       names of reference images already uploaded to ComfyUI (1..4)
 * @param {number} o.seconds
 * @param {number} o.megapixels     base-pass size
 * @param {number} [o.upscaleMegapixels] 0/undefined = no upscale pass
 * @param {number} o.seed
 * @param {number} [o.aspect]
 * @param {boolean} [o.audio] false = a silent video: the sound track is not decoded or saved
 */
function buildH3Graph({ prompt, images, seconds, megapixels, upscaleMegapixels = 0, seed, aspect = 16 / 9, audio = true }) {
    if (!images?.length) throw new Error('Add at least one reference image.');
    if (images.length > MAX_REFERENCES) throw new Error(`At most ${MAX_REFERENCES} reference images are supported.`);
    const { width, height } = sizeForMegapixels(megapixels, aspect);
    const graph = {
        1: { class_type: 'CLIPLoader', inputs: { clip_name: MODEL_FILES.textEncoder, type: 'minimax', device: 'default' } },
        2: { class_type: 'VAELoader', inputs: { vae_name: MODEL_FILES.videoVae } },
        3: { class_type: 'VAELoader', inputs: { vae_name: MODEL_FILES.audioVae } },
        4: { class_type: 'UNETLoader', inputs: { unet_name: MODEL_FILES.diffusion, weight_dtype: 'default' } },
        5: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['4', 0], lora_name: MODEL_FILES.lora, strength_model: 1 } },
        6: { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['5', 0], shift_video: 6, shift_audio: 3 } },
        7: { class_type: 'ModelAttentionBackend', inputs: { model: ['6', 0], attention: 'comfy kitchen attention' } },
        10: {
            class_type: 'MiniMaxH3ReferenceToVideo',
            inputs: {
                clip: ['1', 0], prompt, width, height, length: framesForSeconds(seconds), ref_image_size: 'match',
                vae: ['2', 0], audio_vae: ['3', 0],
                ...Object.fromEntries(images.map((_, i) => [`ref_images.ref_image_${i}`, [`2${i}`, 0]])),
            },
        },
        11: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['10', 0] } },
        [NODE_BASE_SAMPLER]: {
            class_type: 'KSampler',
            inputs: {
                model: ['7', 0], positive: ['10', 0], negative: ['11', 0], latent_image: ['10', 1],
                seed, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
            },
        },
        13: { class_type: 'VAEDecode', inputs: { samples: [NODE_BASE_SAMPLER, 0], vae: ['2', 0] } },
        14: { class_type: 'VAEDecodeAudio', inputs: { samples: [NODE_BASE_SAMPLER, 0], vae: ['3', 0] } },
        15: { class_type: 'CreateVideo', inputs: { images: ['13', 0], fps: FPS, audio: ['14', 0] } },
        [NODE_SAVE]: { class_type: 'SaveVideo', inputs: { video: ['15', 0], filename_prefix: 'video/OpenGenerativeAI_H3', format: 'auto', codec: 'auto' } },
    };
    images.forEach((name, i) => { graph[`2${i}`] = { class_type: 'LoadImage', inputs: { image: name } }; });

    if (upscaleMegapixels > 0) {
        graph[30] = { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: [NODE_BASE_SAMPLER, 0] } };
        graph[31] = {
            class_type: 'MinimaxH3LatentUpscaler3D',
            inputs: {
                latent: ['30', 0], model_name: MODEL_FILES.upscaler, mode: 'megapixels', 'mode.megapixels': upscaleMegapixels,
                align: 32, enable_temporal_chunking: true, force_unload: true, device: 'cuda', precision: 'fp16',
            },
        };
        graph[32] = { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['31', 0], audio_latent: ['30', 1] } };
        graph[NODE_REFINE_SAMPLER] = {
            class_type: 'KSampler',
            inputs: {
                model: ['7', 0], positive: ['10', 0], negative: ['11', 0], latent_image: ['32', 0],
                seed, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 0.5,
            },
        };
        graph[13] = {
            class_type: 'VAEDecodeTiled',
            inputs: { samples: [NODE_REFINE_SAMPLER, 0], vae: ['2', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 },
        };
        graph[14].inputs.samples = [NODE_REFINE_SAMPLER, 0];
    }
    if (!audio) {
        delete graph[14];
        delete graph[15].inputs.audio;
    }
    return graph;
}

module.exports = {
    FPS, MAX_REFERENCES, MODEL_FILES, MODEL_PATHS,
    NODE_BASE_SAMPLER, NODE_REFINE_SAMPLER, NODE_SAVE,
    framesForSeconds, sizeForMegapixels, buildH3Graph,
};
