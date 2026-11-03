# Frame Studio

A Windows desktop studio for turning product photos into social media posts and reels. Organize products, reusable themes, and character references locally; generate media through your own Google Flow session; review results and export approved images or videos.

**Current version:** `0.13.0-preview.37` (preview).

Frame Studio is an independent personal project and is not affiliated with Google. Google Flow requires internet and an eligible account. Local libraries, image processing, review, and export work offline once the required tools are installed.

## Features

- **Projects and libraries:** product photos, reusable themes and prompts, character references, project snapshots, and storyboards.
- **Google Flow companion:** explicitly pair the desktop app with a signed-in Chrome tab, submit generation requests, collect matching results, and request image changes.
- **Multiple projects:** separate Flow tabs, queues, and result folders for each project.
- **Review:** browse generated versions, leave change instructions, approve selected results, and retry local cleanup.
- **Local image processing:** crop, rotate, resize, and repair supported visible logo regions using Sharp and the bundled MI-GAN model. Reconstructed regions require visual review; invisible SynthID removal is not provided.
- **Exports:** export approved Post images in batches or combine approved Reel clips with FFmpeg.
- **Desktop workspace:** local SQLite storage, managed media files, and persistent light/dark preferences.

The Flow integration depends on the live browser interface and account access. Included checks do not guarantee compatibility with every Flow account or future interface change. Manual media import remains available.

## Requirements

- Windows x64 for the desktop app and installer.
- Node.js **24 or newer**, npm, and Git for development.
- Google Chrome and your own signed-in Google Flow session for online generation.
- `ffmpeg` and `ffprobe` on `PATH` for Reel export. Post image export does not need them.

FFmpeg is not bundled with the installer. After installing both tools and restarting Frame Studio, verify them in a new terminal:

```powershell
ffmpeg -version
ffprobe -version
```

## Run locally

```powershell
git clone https://github.com/Smit-Kansagra/frame-studio.git
cd frame-studio
npm ci
npm run dev
```

`npm run dev` compiles the Electron code, starts Vite at `127.0.0.1:5173`, and opens the desktop app. Restart the command after changing Electron source.

To run a production build:

```powershell
npm run build
npm start
```

`npm run dev:ui` starts a browser-only UI preview; desktop storage and integrations require Electron.

## Connect Google Flow

1. Open Frame Studio Settings and select **Open companion extension folder**.
2. Open `chrome://extensions` in Chrome, enable **Developer mode**, and choose **Load unpacked** with that folder. For source development, use this repository's `extension/` directory.
3. Open your signed-in Flow workspace and refresh the tab.
4. Select **Connect Flow** in Frame Studio, copy the temporary pairing code, and paste it into the companion extension popup on the Flow tab.
5. Keep Chrome and Frame Studio open while generating and collecting results.

Pairing is revocable. Google verification prompts require your attention. See [the companion guide](extension/README.md) for generation, recovery, review, and cleanup details.

## Typical workflow

1. Create a theme with a master prompt and any visual references or storyboard scenes.
2. Create a project, add product photos, and choose a theme and optional character references.
3. Review the project settings and prompts, then generate through the connected Flow session or import downloaded media.
4. Review each result and request changes where needed. Post images finish local cleanup before approval.
5. Approve the desired versions and export images or combine approved Reel clips.

Back up the complete workspace shown in Settings with the app closed so the database and managed media stay together.

## Build a Windows installer

```powershell
npm ci
npm run package:win
```

The installer is written to `release/Frame-Studio-0.13.0-preview.37-x64-Setup.exe`. The version comes from `package.json`.

Alternatively, `npm run build:installer` writes into `release/<version>/`, which avoids replacing an open unpacked build. Installers are unsigned; automatic updates are not configured. Keep installers in GitHub Releases rather than committing them to the source repository.

## Development checks

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Check renderer and Electron TypeScript |
| `npm run build` | Type-check and build the production app |
| `npm run check:storage` | Isolated database, image, and persistence checks |
| `npm run check:products` | Product storage and restart checks |
| `npm run check:themes` | Themes, revisions, prompts, and image edits |
| `npm run check:characters` | Character references and persistence |
| `npm run check:projects` | Project setup and snapshots |
| `npm run check:flow` | Flow service checks |
| `npm run check:companion` | Companion transport checks |
| `npm run check:extension-browser` | Extension browser checks |
| `npm run check:reel-export` | Real local video export; requires FFmpeg and FFprobe |
| `npm run check:shell` | Built desktop UI checks; requires a build and desktop session |
| `npm run check:package-input` | Installer configuration and icon validation |
| `npm run check:package-output` | Default packaged output validation |

Checks may create disposable data under ignored `artifacts/`. Browser and desktop checks need permission to launch their applications. `npm run check:package` expects the default `release/win-unpacked/` output from `package:win`.

## Project structure

```text
src/             React interface and styles
electron/       Desktop process, IPC, storage, Flow integration, media workers
extension/      Chrome Flow Companion extension
scripts/        Development, packaging, and verification scripts
third-party/    Required model, metadata, and third-party license notices
build/          Generated installer icon
```

The stack uses Electron, React, TypeScript, Vite, SQLite, Sharp, ONNX Runtime, Playwright, and WebSocket transport. Dependency versions are pinned in `package.json` and `package-lock.json`.

Keep `third-party/migan/migan_pipeline_v2.onnx`: it is a required runtime asset, not an old build. Its pinned checksum, origin, and licenses are stored beside it. Additional attribution is in `third-party/gemini-watermark/`.

## Upload this local project to GitHub

For a new, empty GitHub repository, run these commands in PowerShell:

```powershell
cd C:\Users\kansa\Desktop\software
git init -b main
git add .
git status
git commit -m "Initial Frame Studio project"
git remote add origin https://github.com/Smit-Kansagra/frame-studio.git
git push -u origin main
```

Complete GitHub authentication when prompted. If Git asks for your identity, set `git config user.name "Your Name"` and `git config user.email "your GitHub email"`, then repeat the commit and push.

These initial-upload commands assume the remote has no commits. If it already contains files, clone it into a separate folder and copy this project's source into that clone, respecting `.gitignore`, then commit and push. Do not force-push over existing history.

For later changes:

```powershell
git add .
git commit -m "Describe your changes"
git push
```

The `.gitignore` excludes dependencies, compiled output, installers, verification caches, test screenshots, environment secrets, and temporary files. Review `git status` before committing. Keep the lockfile, source, checks, extension, model, and third-party notices in Git.

See [GitHub's existing-project upload guide](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github).

