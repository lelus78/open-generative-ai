# Using Open Generative AI from Claude Code

While the app is open it runs a local MCP server, `open-generative-ai`, so Claude Code (or any MCP
client) can use the models on your own GPU: images, picture edits, video, lip sync, music, sound
effects, MiniMax H3 shots and the whole movie maker. What the assistant makes shows up in the app
while it works. Nothing goes to the cloud.

This guide covers setup, the tools and practical advice. Times were measured on an RTX 4080 16 GB.
The parts you need can be pasted into a project's `CLAUDE.md`.

## Setup

### The app must be open, with MCP turned on

The server lives inside the desktop app: if the app is closed, every tool fails.

Settings → Local Models → **Let AI assistants use this app (MCP)**. It is off by default; when on,
the app listens on `127.0.0.1:47821` only, needs a random bearer token and refuses browser
requests (any `Origin` header), so a web page cannot start generations on your PC.

### Registering the server

The settings (and the **MCP & CLI** tab) show a ready command with your token. For Claude Code, at
user scope so it is available in every project:

```bash
claude mcp add --scope user --transport http open-generative-ai http://127.0.0.1:47821/mcp \
  --header "Authorization: Bearer <token shown in Settings>"
```

The **MCP & CLI** tab also has copy-paste setups for Cursor, Windsurf, Gemini CLI, Cline and any
other MCP client. After an app update, reconnect with `/mcp` so Claude Code sees the new tool
descriptions.

**Start with `list_models`.** It says which models this PC can run and which are already
downloaded. A model that is not downloaded downloads on first use (gigabytes, minutes).

## Tools

| Area | Tools |
|---|---|
| **Models** | `list_models` (`kind` = image, edit, video, lipsync, audio) |
| **Images** | `generate_image`, `edit_image` (an instruction, e.g. "make the fire blue"), `edit_picture` (crop, rotate, flip, brightness, contrast, colour, no AI) |
| **Prompts** | `enhance_prompt` (`kind` = image, video, music or sfx; local Qwen, any language in) |
| **Video** | `generate_video` (text or a start picture), `make_lipsync` (portrait + audio), `h3_shot` (MiniMax H3 with up to 4 reference pictures that stay faithful) |
| **Sound** | `generate_music`, `generate_sound_effect` (Stable Audio 3, 2–120 s) |
| **Movie** | `movie_options` → `movie_storyboard` → make the shots → `movie_render`; also `movie_upscale`, `movie_title_clip` (transparent title), `movie_last_frame`, `movie_probe`, `movie_library`, `movie_open_in_app` |
| **Reels** | `movie_reel` (photos of one creation → vertical reel; `action` = plan, open, render) |
| **Jobs** | `job_status`, `list_jobs`, `cancel_job`, `cancel_generation` |
| **Files and debugging** | `recent_results`, `show_folder`, `debug_log` |

Prompts can be in any language: they are translated locally before they reach the model.

## Long work runs as a job

Tools do not block until done. Each one waits up to `wait_seconds` (max 55, default 50) and then:

- answers with the result if it finished, or
- answers with a **job id**. Call `job_status` with that id and `wait_seconds` to keep waiting; it
  reports progress and an estimate of the time left.

One GPU job runs at a time; the others queue. Results carry structured content (`path`, `seed`,
`job_id`, `progress`) next to the text: use the absolute paths they return, all on this PC.

## Workflow

1. `list_models`: what is ready, what fits this PC.
2. `enhance_prompt` with the right `kind` if the prompt is only a few words.
3. Make the media (`generate_image`, `generate_video`, `h3_shot`, `generate_music`...).
4. If the answer is a job id: `job_status` until it is done.
5. For a movie: `movie_options` for the valid ids, `movie_storyboard` to plan the shots, make each
   shot, `movie_render` with the paths, `movie_open_in_app` to hand it to the user.

## Practical advice

- **First use is slow.** A heavy model loads into the GPU the first time and again after the app
  has been idle (ComfyUI is stopped after 15 minutes unused): the first video after a pause
  can take several minutes, a later one under a minute. Don't treat it as an error.
- **Rough times** (RTX 4080): an image with Z-Image Turbo ~18 s, picture-to-video with Hunyuan
  Video 1.5 ~40–70 s per clip once the model is loaded.
- **Sound effects** want one plain sentence about the sound itself ("car tires screeching on
  asphalt as the car speeds away"), not a story. **Music** wants genre, instruments, mood and BPM.
- **Keep an object faithful** across shots with `h3_shot` and the object's photos as references;
  move the camera and the light, not the object.
- **Real people:** a video or edit model can change a face. When a photo shows a real person,
  keep it as a picture with a camera move (`movie_render`, `movie_reel` with `faces`) unless the
  user asks otherwise.
- **Lip sync** needs the 22 GB InfiniteTalk model; without it `make_lipsync` says so and
  downloads nothing.

## Reading errors

`debug_log` has the details. Don't keep changing the prompt for an error that is not about the prompt.

| Message | What to do |
|---|---|
| "out of memory" / "CUDA error" | The model does not fit next to what is loaded: wait for other jobs, use a smaller size or a shorter clip, or a lighter model from `list_models`. |
| "not downloaded" / "not installed" | Tell the user what is missing (Settings → Local Models) or pick a ready model; don't retry the same call. |
| "already running" | One GPU job at a time: `job_status` or `list_jobs`, then try again. |
| "Wan2GP is not configured" / "ffmpeg was not found" | A setup step for the user, not something a retry fixes. |
| "must be the absolute path of an existing …" | Pass a full path on this PC, as returned by a previous result. |
| "Generation cancelled" | The user or `cancel_job` stopped it; don't start it again unless asked. |

A result that looks wrong (a different person, a missing object) needs a different prompt or
different references, not different settings.

## Ready-made recipes

The server also offers MCP prompts, which Claude Code shows as slash commands:

- **`reel_from_photos`**: a vertical reel (Discovery and/or Showcase) from the photos of one creation.
- **`product_spot`**: a short product video with H3 shots that keep the real object faithful, music and an end title.
- **`music_video`**: music first, then pictures and clips cut to its length.
