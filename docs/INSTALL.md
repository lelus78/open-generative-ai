# Install

Open Generative AI — Local Edition runs on your own PC. Pick the way that suits you.

## 1. The installer (Windows, easiest)

1. Download `Open-Generative-AI-Setup-<version>.exe` from the [Releases page](https://github.com/lelus78/open-generative-ai/releases).
2. Run it. Windows may show a *SmartScreen* warning because the installer is not signed: choose **More info → Run anyway**.
3. Start **Open Generative AI** from the Start menu.
4. Open **Settings → Local Models** and follow the three steps (each is one click):
   - **sd.cpp engine → Install** (small, for the light image models).
   - **Wan2GP → Install automatically** (optional, for the big image models, video, lip sync and music; needs an NVIDIA GPU).
   - Pick a model in a studio: the picker tells you if your PC can run it and how big the download is.

Nothing is uploaded: models, results and history stay on your disk. Models are downloaded the first time you use them.

## 2. From source (Windows, macOS, Linux)

Needs [Git](https://git-scm.com/) and [Node.js 18+](https://nodejs.org/).

```powershell
git clone --recurse-submodules https://github.com/lelus78/open-generative-ai
cd open-generative-ai
powershell -ExecutionPolicy Bypass -File setup.ps1            # app only
powershell -ExecutionPolicy Bypass -File setup.ps1 -Wan2GP    # + Wan2GP (NVIDIA GPU)
start.bat
```

On macOS and Linux: `npm run setup` and then `npm run electron:dev`.

## 3. Build the installer yourself

```bash
npm run setup
npm run electron:build:win     # Windows installer in release/
```

## What you need

| | Minimum | Good |
|---|---|---|
| **Images (sd.cpp)** | any recent PC, a GPU with 6–8 GB helps | 12 GB VRAM |
| **Big images, video, music (Wan2GP)** | NVIDIA GPU, 8 GB VRAM | 16 GB VRAM, 32 GB RAM |
| **Movie studio** | ffmpeg (the one inside Wan2GP is found automatically) | — |
| **MiniMax H3 shots (Anime tab, movie shots)** | your own ComfyUI with the H3 files | 16 GB VRAM |
| **Disk** | 10 GB for the light models | 100 GB+ if you keep several big models |

The picker rates every model against *your* GPU, RAM and free disk before you download it.

## Use it from an AI assistant (MCP)

Settings → Local Models → **Let AI assistants use this app (MCP)**. The app shows the command to paste into Claude Code, Cursor or any MCP client. Only `127.0.0.1` is listened to, with a random token.

## Problems?

- **The app opens but a studio says a model is not ready:** Settings → Local Models shows what is missing and why.
- **Something failed:** the bug icon in the top bar opens the **Debug log** (what each tool did, with the prompt sent to the model). *Copy all* and paste it in an issue.
- **A heavy model makes the PC slow while it loads:** that is the GPU at work; cancel from the studio, or pick a lighter model (the picker rates them).
- **MCP does not start (port in use):** the default port is 47821; another program (for example a gaming-peripheral service) may already use it. Change `"port"` in `%APPDATA%\open-generative-ai\mcp-control.json` and restart the app.

## Updates

The installed app checks GitHub Releases a few seconds after it starts. When a newer version exists it asks whether to download it; the update is installed when you close the app. Models and results are not touched. (Running from source: `git pull`.)
