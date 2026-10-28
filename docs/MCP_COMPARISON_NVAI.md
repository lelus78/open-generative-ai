# Open Generative AI and NVAI-open: the two MCP servers side by side

A comparison of the two `CLAUDE_CODE.md` guides: [Open Generative AI](CLAUDE_CODE.md) and
[NVAI-open](https://github.com/Mantux775/NVAI-open/blob/main/docs/CLAUDE_CODE.md), as of 28 October 2026.
Both run local generation on one NVIDIA GPU (16 GB) and give Claude Code the same kind of access. The
goal is to see where they line up, where they differ, and what could be aligned.

## At a glance

| | Open Generative AI | NVAI-open |
|---|---|---|
| Where the server lives | Inside the Electron desktop app (the app must be open, MCP switched on in Settings) | Python MCP server, thin client of a REST server on `127.0.0.1:8100` (web UI and MCP share one queue) |
| Transport | HTTP `127.0.0.1:47821/mcp`, bearer token, browser requests refused | stdio, started by Claude Code (`python -m nvai.mcp_server`) |
| First call | `list_models` | `health` (backend, active model per category, queues, 3D worker) |
| Long work | Returns a **job id** after `wait_seconds` (max 55); `job_status` reports progress and ETA | `generate_*` **block until done** (MCP wrapper limit being aligned to the server's 60 min) |
| Files | Absolute paths in and out | Absolute paths out; inputs mostly by **asset id** (`image_asset_id`, `reference_asset_ids`) |
| Focus | Video and movies: H3 shots, movie maker, reels, lip sync, music | Images and game assets: measured model choice, LoRAs, 3D meshes, old-photo restore, Studio editing |
| Measured on | RTX 4080 16 GB | RTX 5060 Ti 16 GB |

## Tools mapped

| Area | Open Generative AI | NVAI-open | Notes |
|---|---|---|---|
| Status | — | `health` | Worth adding on our side: one call that says what is running and loaded. |
| Models | `list_models(kind)` | `list_models(kind, detailed)`, `download_model`, `delete_model`, `set_active_model` | NVAI manages models explicitly; ours downloads on first use. |
| Image | `generate_image` | `generate_image` (+ `loras`, `batch_size`) | Same name. |
| Image edit | `edit_image` (instruction), `edit_picture` (crop, colour, no AI) | `generate_image` with `reference_asset_ids` (FLUX 3) | Different shape for the same job. |
| Prompt help | `enhance_prompt(kind)` | `expand_prompt(target)` | Same idea, different names and parameter. |
| Video | `generate_video` (text or start picture), `h3_shot` (up to 4 references) | `generate_video` (LTX-2.5 first choice, `loras`, `loop`) | Same name; start image is a path for us, an asset id for NVAI. |
| Lip sync | `make_lipsync` | — (spoken lines go in the LTX prompt) | |
| Audio | `generate_music`, `generate_sound_effect` | `generate_audio` (SFX or music) | One tool there, two here. |
| 3D | — | `image_to_3d`, `text_to_3d` | NVAI only. |
| Photo restore | — | `restore_image` | NVAI only. |
| Upscale | `movie_upscale` (fast / AI) | inside `restore_image` and the Studio export | |
| Whole videos | Movie maker: `movie_storyboard` → shots → `movie_render`, `movie_open_in_app`, `movie_reel` | Studio: `studio_create`, `studio_command`, `studio_generate`, `studio_export` | Same goal. NVAI's Studio is a real editor (tracks, razor, trim, `chain` markers, AI task markers). |
| Jobs | `job_status`, `list_jobs`, `cancel_job`, `cancel_generation` | `studio_get` shows scene status; no job tools for single generations | The main structural difference. |
| History | `recent_results`, `movie_library`, `show_folder` | `list_assets`, `delete_asset`, `clear_history`, `copy_asset` | |
| Debugging | `debug_log` | backend log via REST (`/api/backend/log`) | |
| Recipes | MCP prompts: `reel_from_photos`, `product_spot`, `music_video` | Recipes in the guide (explainer with a presenter, comedy scenes) | |

## Long jobs: the one design choice that matters most

Blocking calls are simple and work well for short jobs. For video, the job id model avoids two failures that
the NVAI thread found on its own side: a job queued behind another one can time out on the Claude side
while the GPU keeps working, and a cancelled call never hears about the finished result. With a job id,
the job belongs to the app, and any later call, even from a new session, can ask `job_status` or
`list_jobs` and pick up the result.

A middle way for NVAI without changing every tool: keep blocking, but start the timeout when the job
starts running, and when the wrapper gives up, return the job id instead of an error, plus a small tool
that lists recent finished jobs.

## What each side could borrow

From NVAI-open to Open Generative AI:
- a `health` tool to call first;
- the "recommended settings at a glance" table with measured reasons (model, size, steps, prompt shape);
- LoRA support listed by `list_models(kind="lora")`;
- Studio ideas: `chain` markers between shots and AI task markers left by the user.

From Open Generative AI to NVAI-open:
- job ids with progress and ETA for long generations;
- structured results (`path`, `seed`, `job_id`, `progress`) next to the text;
- reference-faithful shots (`h3_shot`) and the rule "move the camera and the light, not the object";
- the real-people rule: keep a real person's photo as a picture with a camera move unless asked.

## Aligning the shared tools (proposal for the next step)

The same Claude instructions could work on both apps if the overlapping tools agreed on:

| Tool | To agree on |
|---|---|
| `list_models` | the `kind` values (image, edit, video, audio, lipsync, lora, 3d) and the fields `downloaded` / `can_run` |
| `generate_image` | `prompt`, `model`, `width`/`height` or `aspect_ratio`, `seed`, `negative_prompt`; the result as `paths` |
| `generate_video` | the start image as a path *or* an asset id (accept both), `seconds` or frames, `seed` |
| prompt help | one name (`enhance_prompt` / `expand_prompt`) and one parameter (`kind` / `target`) |
| long jobs | if a call returns a job id, the same `job_status(job_id, wait_seconds)` shape on both |
