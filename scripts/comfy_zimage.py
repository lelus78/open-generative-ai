"""Generate one image with Z-Image Turbo on the local ComfyUI and save it.

usage: python comfy_zimage.py out.png width height "prompt"
"""
import json, random, sys, time, urllib.request, urllib.parse, uuid

HOST = "http://127.0.0.1:8188"


def api(path, data=None):
    req = urllib.request.Request(HOST + path, json.dumps(data).encode() if data else None, {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))


def build(prompt, w, h):
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "z_image_turbo_bf16.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_3_4b.safetensors", "type": "lumina2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
        "4": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": 3}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "6": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["5", 0]}},
        "7": {"class_type": "EmptySD3LatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "8": {"class_type": "KSampler", "inputs": {"model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["7", 0],
                                                  "seed": random.randint(1, 2**31), "steps": 8, "cfg": 1, "sampler_name": "res_multistep", "scheduler": "simple", "denoise": 1}},
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
        "10": {"class_type": "SaveImage", "inputs": {"images": ["9", 0], "filename_prefix": "h3_refs/ref"}},
    }


if __name__ == "__main__":
    out, w, h, prompt = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    pid = api("/prompt", {"prompt": build(prompt, w, h), "client_id": uuid.uuid4().hex})["prompt_id"]
    while True:
        hist = api(f"/history/{pid}")
        if pid in hist:
            break
        time.sleep(2)
    h = hist[pid]
    if h["status"]["status_str"] != "success":
        sys.exit(json.dumps(h["status"])[:1500])
    im = h["outputs"]["10"]["images"][0]
    q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im["subfolder"], "type": im["type"]})
    open(out, "wb").write(urllib.request.urlopen(f"{HOST}/view?{q}").read())
    print("saved", out)
