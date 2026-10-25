"""Run the MiniMax H3 reference-to-video workflow on a local ComfyUI (API format, base pass only).

usage: python h3_comfy_run.py out_name seconds megapixels upscale_megapixels(0=off) prompt_file ref1.png [ref2.png ...]
"""
import json, math, sys, time, urllib.request, urllib.parse, uuid, random, mimetypes, os

HOST = "http://127.0.0.1:8188"


def post_json(path, data):
    req = urllib.request.Request(HOST + path, json.dumps(data).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))


def get_json(path):
    return json.load(urllib.request.urlopen(HOST + path))


def upload(path):
    b = uuid.uuid4().hex
    name = os.path.basename(path)
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n"
            f"Content-Type: {mimetypes.guess_type(path)[0] or 'image/png'}\r\n\r\n").encode()
    body += open(path, "rb").read() + f"\r\n--{b}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{b}--\r\n".encode()
    req = urllib.request.Request(HOST + "/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={b}"})
    return json.load(urllib.request.urlopen(req))["name"]


def size_for(mp, aspect=16 / 9, mult=32):
    h = math.sqrt(mp * 1e6 / aspect)
    w = h * aspect
    return round(w / mult) * mult, round(h / mult) * mult


def frames_for(seconds):
    a = max(5, round(seconds * 24))
    return a + (5 - (a % 17)) % 17


def build(prompt, refs, seconds, mp, seed, up_mp=0):
    w, h = size_for(mp)
    g = {
        "1": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "device": "default"}},
        "2": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "4": {"class_type": "UNETLoader", "inputs": {"unet_name": "h3\\minimax_h3_ref2va_pruned_int8_convrot.safetensors", "weight_dtype": "default"}},
        "5": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["4", 0], "lora_name": "h3\\minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors", "strength_model": 1}},
        "6": {"class_type": "MiniMaxH3SigmaShift", "inputs": {"model": ["5", 0], "shift_video": 6, "shift_audio": 3}},
        "7": {"class_type": "ModelAttentionBackend", "inputs": {"model": ["6", 0], "attention": "comfy kitchen attention"}},
        "10": {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
            "clip": ["1", 0], "prompt": prompt, "width": w, "height": h, "length": frames_for(seconds),
            "ref_image_size": "match", "vae": ["2", 0], "audio_vae": ["3", 0],
            **{f"ref_images.ref_image_{i}": [f"2{i}", 0] for i in range(len(refs))}}},
        "11": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["10", 0]}},
        "12": {"class_type": "KSampler", "inputs": {"model": ["7", 0], "positive": ["10", 0], "negative": ["11", 0], "latent_image": ["10", 1],
                                                    "seed": seed, "steps": 8, "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 1}},
        "13": {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0], "vae": ["2", 0]}},
        "14": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["12", 0], "vae": ["3", 0]}},
        "15": {"class_type": "CreateVideo", "inputs": {"images": ["13", 0], "fps": 24, "audio": ["14", 0]}},
        "16": {"class_type": "SaveVideo", "inputs": {"video": ["15", 0], "filename_prefix": "video/MiniMax_H3", "format": "auto", "codec": "auto"}},
    }
    for i, name in enumerate(refs):
        g[f"2{i}"] = {"class_type": "LoadImage", "inputs": {"image": name}}
    if up_mp:
        g["30"] = {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["12", 0]}}
        g["31"] = {"class_type": "MinimaxH3LatentUpscaler3D", "inputs": {
            "latent": ["30", 0], "model_name": "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors",
            "mode": "megapixels", "mode.megapixels": up_mp, "align": 32, "enable_temporal_chunking": True,
            "force_unload": True, "device": "cuda", "precision": "fp16"}}
        g["32"] = {"class_type": "LTXVConcatAVLatent", "inputs": {"video_latent": ["31", 0], "audio_latent": ["30", 1]}}
        g["33"] = {"class_type": "KSampler", "inputs": {"model": ["7", 0], "positive": ["10", 0], "negative": ["11", 0], "latent_image": ["32", 0],
                                                        "seed": seed, "steps": 4, "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 0.5}}
        g["13"] = {"class_type": "VAEDecodeTiled", "inputs": {"samples": ["33", 0], "vae": ["2", 0], "tile_size": 512, "overlap": 64, "temporal_size": 64, "temporal_overlap": 8}}
        g["14"]["inputs"]["samples"] = ["33", 0]
    return g


if __name__ == "__main__":
    out, secs, mp, up_mp, pfile, *imgs = sys.argv[1:]
    refs = [upload(p) for p in imgs]
    graph = build(open(pfile, encoding="utf8").read(), refs, float(secs), float(mp), random.randint(1, 2**31), float(up_mp))
    pid = post_json("/prompt", {"prompt": graph, "client_id": uuid.uuid4().hex})["prompt_id"]
    print("queued", pid, flush=True)
    while True:
        hist = get_json(f"/history/{pid}")
        if pid in hist:
            h = hist[pid]
            print(json.dumps(h["status"].get("status_str")), json.dumps(h.get("outputs"))[:500])
            if h["status"].get("status_str") != "success":
                print(json.dumps(h["status"])[:2000])
            break
        time.sleep(5)
