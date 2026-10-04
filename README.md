# Motion Studio

<img width="1919" height="1029" alt="image" src="https://github.com/user-attachments/assets/557afee8-ab7a-4b08-b035-cc868bc4816f" />


Motion Studio is a local video studio for creating short animations from text prompts and reference images. The React/Vite interface uses two local generation engines:

- **Wan 2.1 1.3B + ComfyUI** for text-to-video (T2V).
- **LTX Video + LTX Desktop** for image-to-video (I2V).

Generation requests, imported images, audio, and rendered videos stay on the computer.

## Features

### Prompt and input

- Edit the single video prompt directly, up to 1,000 characters.
- Write prompts in Italian and translate them locally to English with the installed LTX Gemma enhancer. The English result replaces the Italian text in the same prompt field; prompts entered directly in English remain unchanged. Translation stays on this computer and is not sent to an external service.
- Import, replace, and remove PNG, JPEG, and WebP reference images.
- Import an audio track, preview it, and choose its start point. The music is mixed from that position into the video.

### Generation

- Choose between **LTX Video** and **Wan 2.1 · 1.3B** when the model is installed.
- Choose a duration of 3, 5, 8, or 10 seconds.
- Choose a 16:9 or 9:16 generation format supported by LTX.
- Use the **Facebook Reel · 1080 × 1920** export preset for a portrait MP4 ready to upload as a Facebook Reel. The preset selects 9:16 and 5 seconds, and normalizes the LTX result to H.264, 30 fps, AAC, and fast-start MP4 metadata.
- Generate image-to-video animations with LTX Desktop. LTX requires a reference image and supports 16:9 and 9:16 in this application.
- Generate text-to-video animations with the local Wan workflow in ComfyUI.
- Validate incompatible model and reference-image combinations before starting a render.
- Show connecting, rendering, completion, and error status messages in the studio.
- Render entirely on local services; no generation request is sent to the cloud.

### Results and projects

- Preview generated video with native playback controls.
- Download the generated result as an MP4 or remove it from the preview.
- Extend a generated video by 5, 10, or 20 seconds.
- Use the native LTX extension endpoint when supported, or automatically fall back to last-frame continuation and FFmpeg concatenation when it is not.
- Start the selected music at the chosen point and mix it into the generated video through the local bridge and FFmpeg.
- Restore the most recent local MP4 when the application starts.
- Start a new video and clear the current image, audio, prompt, and generated result.

### Windows desktop and hardware

- Use **Settings** from the top bar next to **Local mode** to configure the video output folder.
- Open the native Windows folder picker and persist the selected output directory.
- Detect the GPU renderer in the interface and read NVIDIA GPU name, total VRAM, and used VRAM through the local Windows bridge.
- Start the local bridge and the optional LTX backend automatically in the Electron desktop app.
- Show local GPU readiness and the active VRAM summary in the sidebar.
- Keep the application in local mode with no cloud generation service.

## Requirements

- Windows 10 or Windows 11.
- Node.js and npm.
- Python 3.11 in `ComfyUI/.venv`.
- An NVIDIA GPU with sufficient VRAM. The verified configuration uses an RTX 5060 Ti with 16 GB.
- Wan model files installed in `ComfyUI/models`.
- FFmpeg available on `PATH` when audio mixing is used.
- LTX Desktop installed in the local paths expected by the desktop process when LTX is used.

## Local development

Install the JavaScript dependencies:

```powershell
npm install
```

Start ComfyUI from the project root:

```powershell
.\ComfyUI\.venv\Scripts\python.exe ComfyUI\main.py --listen 127.0.0.1 --port 8188 --enable-cors-header --lowvram --reserve-vram 1
```

In a second terminal, start the Vite interface:

```powershell
npm run dev
```

Open `http://127.0.0.1:5173/`.

To restart the local services and start ComfyUI, the Motion bridge, and Vite together:

```powershell
npm run restart:local
```

The PowerShell script stops related project processes and checks the local ports before starting the requested services. Use its switches directly when only some services are needed:

```powershell
.\scripts\restart-local.ps1 -StartComfy -StartVite
```

## Desktop application

Run Electron in development:

```powershell
npm run desktop
```

Create the Windows portable executable:

```powershell
npm run desktop:build
```

The packaging command builds the frontend first and then runs `electron-builder`. The artifact is written to `release/Motion-Studio-0.1.0.exe`.

The desktop process creates the Electron window, starts the Motion bridge, starts LTX Desktop's backend when its expected installation is present, and stops the related services when the application exits. Desktop logs are written to Electron's local logs directory.

## Typical workflow

1. Open Motion Studio and confirm that **Local mode** and **GPU ready** are visible.
2. Select **Settings** in the top bar if the output folder needs to be changed.
3. For image animation, import a reference image and select **LTX Video**. For a Facebook Reel, choose **Facebook Reel · 1080 × 1920** and keep LTX selected. For generated scenes without a reference image, select **Wan 2.1 · 1.3B**.
4. Edit the video prompt directly to describe the desired motion.
5. Choose duration and format, optionally insert audio, and select **Generate video**.
6. Preview, download, delete, or extend the result. Audio is mixed locally after video generation.

For LTX, the reference image controls the visual identity and composition. Describe the requested subject action positively and specifically (for example, who waves, smiles, or turns their head). Motion Studio reinforces visible subject movement and a locked camera in the image-to-video prompt; negative camera instructions are removed from the positive prompt because the local Fast pipeline does not use its negative-prompt field.

## Local architecture

- `src/`: React interface and application styles.
- `public/wan_text_to_video_api.json`: API workflow submitted to ComfyUI.
- `scripts/ltx-bridge.mjs`: local API for configuration, GPU/VRAM information, LTX generation, video extension, latest-output restore, directory selection, and audio mixing.
- `scripts/ltx-server.py`: adapter for the LTX Desktop backend.
- `scripts/restart-local.ps1`: Windows process and service restart helper.
- `electron/main.cjs`: Electron window creation and local service lifecycle.
- `motion-config.json`: initial output-directory configuration. Electron stores the saved path in the user data directory.
- `ComfyUI/`: local ComfyUI installation, workflows, models, and runtime data. This checkout is intentionally excluded from the Motion repository because it contains a nested Git repository, Python environments, model weights, caches, and generated media.

Main local endpoints:

- Vite: `http://127.0.0.1:5173`.
- ComfyUI: `http://127.0.0.1:8188`.
- Motion bridge: `http://127.0.0.1:41955`.
- LTX Desktop backend: port `41954`, when installed and available.

The bridge exposes local operations for reading and saving the output directory, reading Windows GPU/VRAM information, opening the Windows directory picker, restoring the latest MP4, generating through LTX, extending a video, and mixing audio into a video.

## GPU configuration and limitations

The Wan workflow is tuned for 512x288, 17 frames, and 12 steps on an RTX 5060 Ti with 16 GB VRAM. The interface maps the selected aspect ratio to the workflow dimensions and calculates the frame count from the selected duration. The bridge reads VRAM from `nvidia-smi.exe` on Windows and falls back to `Win32_VideoController` through PowerShell when NVIDIA utilities are unavailable.

Wan is text-to-video only in this application. Reference images are intentionally rejected for Wan; select LTX Video for image-to-video generation. Wan 2.2 and the full HunyuanVideo workflow are not included because of their higher memory requirements.

LTX currently accepts only 16:9 and 9:16 generation formats, which are the only formats exposed by the format selector. Facebook export presets may normalize the generated video to their preset dimensions after generation. Reference images are resized into the target canvas before they are sent to the local LTX bridge. This local I2V path supports clips up to 10 seconds: Motion Studio uses 1080p for clips up to 5 seconds and 720p for longer clips. Direct LTX extension may return an unsupported response on some local installations; the bridge then creates continuation clips from the last frame and concatenates them with FFmpeg. Audio mixing and fallback extension require a working `ffmpeg` executable.

When a local service is unavailable or a render fails, Motion Studio displays the error in the generation area instead of presenting an invalid video as a successful result.

## npm commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite development server |
| `npm run build` | Run TypeScript checks and build the frontend |
| `npm run preview` | Preview the Vite production build |
| `npm run desktop` | Start the Electron desktop app |
| `npm run desktop:build` | Build the Windows portable executable |
| `npm run restart:local` | Restart local services and start the requested processes |

## License

This project is open source and available under the MIT License.

**Author: Roberto Raimondo -** © 2026 All Rights Reserved.
