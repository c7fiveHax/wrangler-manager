# Wrangler Manager

A desktop IDE for editing HTML files in Cloudflare Workers (Wrangler) projects and deploying them directly to Cloudflare — all from a single native app.

Built with Electron, CodeMirror, and Node.js.

---

## Features

- **Project browser** — scans a root folder and detects all Wrangler projects automatically
- **IDE-quality editor** — syntax highlighting for HTML, CSS, and JavaScript; line numbers; code folding; active line highlight; auto-closing tags and brackets
- **Toolbar tools** — Format (auto-beautify), Comment toggle, Find & Replace, Word Wrap
- **Live preview** — renders the current file in a panel inside the app
- **Multi-file editing** — edit across multiple files without losing changes; each file tracks its own unsaved state with a dot indicator in the sidebar
- **Save All** — saves every modified file to disk in one click (Cmd+S); deploy auto-saves before pushing
- **One-click deploy** — runs `wrangler deploy` and streams the output live to a log panel
- **Smart file detection** — automatically finds HTML files in the `public/` subfolder
- **New file creation** — creates new HTML files inside `public/` to match your project structure
- **Persistent state** — remembers your root folder and project list between launches
- **Native folder picker** — browse for your projects folder using the OS dialog

---

## Requirements

- **macOS** (Windows and Linux builds are supported but untested)
- **Node.js 18+** — download at [nodejs.org](https://nodejs.org)
- **Wrangler** — Cloudflare's CLI tool

### Install Wrangler

```bash
npm install -g wrangler
```

### Authenticate Wrangler with Cloudflare

```bash
wrangler login
```

This opens a browser window to log in to your Cloudflare account. You only need to do this once.

---

## Project structure

```
wrangler_manager/
├── electron/
│   ├── main.js        — Electron main process + embedded HTTP server
│   └── preload.js     — Secure bridge between UI and native APIs
├── index.html         — The full IDE frontend
├── server.js          — Standalone Node server (for running without Electron)
├── package.json       — Dependencies and build config
└── README.md
```

---

## Running in development

### 1. Clone or download the project

```bash
git clone https://github.com/YOUR_USERNAME/wrangler-manager.git
cd wrangler-manager
```

Or download and unzip the source, then `cd` into the folder.

### 2. Install dependencies

```bash
npm install
```

### 3. Launch the app

```bash
npm run electron
```

This opens the app window directly from source. Use this during development to test changes — no build step needed.

---

## Building a distributable app

### macOS

#### Optional: Add a custom icon

You'll need a `1024×1024` PNG file named `icon.png` in your project root. Then run the following from inside the project folder to convert it to the `.icns` format macOS requires:

```bash
mkdir icon.iconset
sips -z 16 16     icon.png --out icon.iconset/icon_16x16.png
sips -z 32 32     icon.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon.png --out icon.iconset/icon_32x32.png
sips -z 64 64     icon.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon.png --out icon.iconset/icon_128x128.png
sips -z 256 256   icon.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   icon.png --out icon.iconset/icon_256x256.png
sips -z 512 512   icon.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   icon.png --out icon.iconset/icon_512x512.png
sips -z 1024 1024 icon.png --out icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset -o electron/icon.icns
rm -rf icon.iconset
```

If you skip this step, the app will use the default Electron icon.

#### Build

```bash
npm run build
```

This produces a `dist/` folder containing:
- `Wrangler Manager-1.2.0-arm64.dmg` — Apple Silicon (M1, M2, M3, M4)
- `Wrangler Manager-1.2.0.dmg` — Intel

#### Install

1. Open the `.dmg` that matches your Mac
2. Drag **Wrangler Manager** into the Applications folder
3. Eject the DMG

#### First launch — Gatekeeper warning

Because the app is not signed with an Apple Developer certificate, macOS will block it the first time. To get past this:

**Option A** — Right-click the app → **Open** → **Open**

**Option B** — Run this command in Terminal after copying to Applications:

```bash
xattr -cr "/Applications/Wrangler Manager.app"
```

You only need to do this once. After that it launches normally from Spotlight, Launchpad, or the Dock.

### Windows

```bash
npm run build:win
```

Produces an `.exe` installer in `dist/`.

### Linux

```bash
npm run build:linux
```

Produces an `.AppImage` in `dist/`.

---

## Running without Electron (browser mode)

If you don't want to use Electron, you can run the app as a local web server instead:

```bash
node server.js
```

Then open **http://localhost:3474** in any browser.

> Note: In browser mode the folder Browse button can only read the folder name, not the full path. You may need to type the full path manually in the text field.

---

## First-time setup in the app

1. **Set root folder** — enter the path to the folder that contains your Wrangler projects, or click **Browse** to use the native folder picker. The app scans for any subfolder containing a `wrangler.toml` file.

2. **Choose projects** — check off the projects you want to manage and click **Add**.

Your selections are saved automatically and restored the next time you launch the app.

---

## How projects are detected

The scanner checks three layouts:

| Layout | Example |
|---|---|
| Root folder is itself a project | `~/projects/` contains `wrangler.toml` |
| Direct subfolders are projects | `~/projects/my-site/wrangler.toml` |
| One level deeper (monorepo) | `~/projects/group/my-site/wrangler.toml` |

HTML files are loaded from (in priority order):
1. The `bucket` path defined in `wrangler.toml` (if set)
2. A `public/` subfolder inside the project
3. The project root

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+S / Cmd+S | Save All (all modified files) |
| Ctrl+/ / Cmd+/ | Toggle comment |
| Alt+Shift+F | Format HTML |
| Ctrl+H | Find & Replace |

---

## Updating the app

When a new version is available:

1. Download or pull the latest source
2. Run `npm install` (in case dependencies changed)
3. Run `npm run build`
4. Open the new `.dmg` and drag the app to Applications, replacing the old version

---

## Troubleshooting

**Deploy fails with `npx: command not found`**
Electron launches outside your normal terminal session and may not have access to your full `PATH`. The app tries to locate `npx` automatically across common install locations (Homebrew, nvm, Volta, fnm). If it still fails, check that Wrangler is installed by running `which npx` in Terminal and confirming it returns a path.

**No projects found after scanning**
- Make sure each project folder contains a `wrangler.toml` file
- If you pointed at the project folder itself, try its parent folder instead
- The "No projects found" screen shows what subfolders were detected to help diagnose the issue

**Wrangler authentication warning in deploy log**
If you see a warning about a Wrangler v1 API token, run `wrangler login` in Terminal to re-authenticate using the current method.

**App blocked by Gatekeeper on macOS**
See the [First launch](#first-launch--gatekeeper-warning) section above.

---

## License

MIT License — Copyright © 2026 Nicholas Percoco

See [LICENSE](LICENSE) for the full license text.
