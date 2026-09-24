# Stack

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Tauri](https://img.shields.io/badge/Desktop-Tauri_2.0-24C8DB)
![React](https://img.shields.io/badge/Frontend-React_18-61DAFB)
![TypeScript](https://img.shields.io/badge/Language-TypeScript-3178C6)
![Rust](https://img.shields.io/badge/Backend-Rust-000000)
![SQLite](https://img.shields.io/badge/Database-SQLite-003B57)
![Vite](https://img.shields.io/badge/Bundler-Vite-646CFF)

![Stack hero](src/assets/images/wallpaper-1.jpg)

Local sample library manager for producers. Splice-inspired interface, fully offline.
Browse, filter by BPM/key, preview audio and MIDI, and organize your own library.

**Download:** [stack.swendl.com](https://stack.swendl.com)

## Installation (macOS)

1. Download the `.dmg` from the releases page or [stack.swendl.com](https://stack.swendl.com)
2. Open the DMG and drag **Stack.app** to your Applications folder
3. If macOS says _"Stack is damaged and can't be opened"_, run this once in Terminal:

```bash
xattr -rd com.apple.quarantine /Applications/Stack.app
```

4. Launch Stack from Applications

> This warning appears because the app is not yet notarized with Apple. The command removes the quarantine flag macOS applies to downloaded files.

## Features

- Offline-first desktop app
- Fast indexing for samples, MIDI, and presets
- BPM/key filtering and full-text search
- Audio waveform and MIDI preview
- Folder-based browser with pack organization
- Browse your library from a phone or another computer on the same network
- Auto-update flow via GitHub Releases

## Tech Stack

- **Desktop:** Tauri 2.0
- **Frontend:** React 18 + TypeScript + Vite
- **Backend:** Rust
- **Database:** SQLite

![Stack browser preview](src/assets/images/wallpaper-2.jpg)

## Prerequisites

- Node.js 20+
- npm
- Rust 1.78+ (stable), install via [rustup](https://rustup.rs)
- macOS: Xcode Command Line Tools (`xcode-select --install`)

## Local Development

```bash
npm install
npm run tauri dev
```

## Production Build

```bash
npm run tauri build
```

The app stores SQLite in the platform-standard app data directory:

- macOS: `~/Library/Application Support/app.stack.desktop/stack.db`
- Linux: `~/.local/share/app.stack.desktop/stack.db`
- Windows: `%APPDATA%\\app.stack.desktop\\stack.db`

## Release

Push a version tag to trigger the release workflow:

```bash
git tag v1.0.0
git push origin v1.0.0
```

## Project Structure

```text
src/              React + TypeScript frontend
src-tauri/src/    Rust backend (commands, core, db, metadata, models)
```

## Browser & Network Access

Stack runs a small HTTP server while the desktop app is open, serving the *same*
UI from the *same* database. Open it in Chrome or Safari on this machine, or on
your phone, and you are looking at the same library — nothing is uploaded
anywhere.

Set it up in **Settings › Web access**:

1. **Serve Stack in a browser** — on by default. Binds `127.0.0.1` only.
2. **Allow other devices on this network** — off by default. Binds `0.0.0.0` so
   phones, tablets and other machines on the same Wi-Fi can reach it.
3. Copy the URL shown for **Other devices** and open it on the phone.

Both toggles and the port take effect immediately; the app does not need a
restart.

### Authentication

A random token is generated on first run and kept in the app data directory, so
the URL stays valid across launches. The URLs shown in Settings already include
it as `?token=…`.

- While Stack is bound to loopback only, local requests need no token.
- The moment **Allow other devices** is on, **every** request to `/__ipc`,
  `/__media` and `/__events` must present the token — as `?token=`, an
  `Authorization: Bearer …` header, or the `stack_token` cookie the server sets
  the first time a page is opened with a valid token. Anything else gets a 401.

The token is the only thing standing between your network and your library, and
the bridge exposes the full command set (including folder removal and plugin
deletion). Treat the link like a password, use it on networks you trust, and
leave LAN access off when you don't need it.

### Can I run Stack in Docker?

No, and there is no Stack Docker image. Stack is a desktop application: the Rust
backend and the native webview are one process, and the webview needs a display
server. There is nothing to run headless in a container.

What the network access above gives you is the same practical result for most
people — run the desktop app on the machine that holds your samples, turn on
**Allow other devices**, and use any browser on your network as the client.

## First Run

1. Launch the app.
2. Click **Add Folder** in the sidebar.
3. Select a folder containing samples, MIDI, or presets.
4. Wait for indexing to complete.
5. Search, filter, and preview assets in the Browser tab.

## License

MIT. See [LICENSE](LICENSE).
