# Examples

All made locally on an RTX 4080 (16 GB), no cloud. Times are for a warm model; the first use of a heavy model takes minutes while it loads.

| File | How it was made | Time |
|---|---|---|
| `knight.jpg` | Image Studio, Z-Image Turbo, 16:9, seed 7: *A lone knight crossing a misty valley at dawn, long shadows, volumetric light, cinematic wide shot, highly detailed* | ~18 s |
| `tavern.jpg` | *A cozy fantasy tavern interior at night, warm lanterns, wooden beams, a crackling fireplace, hand-painted concept art* | ~18 s |
| `tavern-blue-fire.jpg` | The picture above edited with Kroma Edit: *make the fire in the fireplace a magical blue flame, keep everything else the same* | ~1 min |
| `fox.jpg` | *A red fox standing in fresh snow at golden hour, shallow depth of field, soft backlight, wildlife photograph* | ~18 s |
| `alley.jpg` | *A rainy cyberpunk alley at night with neon signs and reflections on wet asphalt, cinematic wide shot* | ~18 s |
| `island.jpg` | *A floating island with a waterfall and a tiny stone castle above the clouds, soft pastel colors, fantasy concept art* | ~18 s |
| `axe.jpg` | *Macro photograph of a hand-painted steel battle axe with a raven emblem on the blade, aged metal, workshop light* | ~18 s |
| `clip-fox.webp`, `clip-island.webp` | Video Studio, picture to video, Hunyuan Video 1.5 (49 frames), e.g. *clouds slowly drift past the floating island, the waterfall flows, slow camera push in* | 40–70 s |
| `music-sample.mp3` | Music tab, Stable Audio 3: *uplifting cinematic electronic, driving pulse, 110 BPM, soaring synth pads, hopeful, instrumental* (first 30 s of 50 s) | ~1 min |

## The demo video, made by an assistant

The 33 s Full HD demo used only the app's MCP tools: `generate_image`, `edit_image`, `generate_video`, `generate_music`, then one `movie_render` call with the scenes, captions (*Cinema serif*), 0.6 s cross-fades and the music. The render itself takes ~14 s.

```text
movie_render { scenes: [ {type:"title", title:"Open Generative AI", title_style:"cinzel"},
                         {path:"knight.png", motion:"zoom-in", caption:"Images from a prompt, locally"}, ...],
               format:"1920x1080", transition:"fade", music_path:"music.wav", fade_in_out:true }
```
