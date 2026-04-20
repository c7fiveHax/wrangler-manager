const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron');
const path   = require('path');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const { spawn, execSync } = require('child_process');

const PORT = 3474;
let mainWindow;
let serverStarted = false;

// ── Embedded server (same logic as server.js, inlined so Electron is self-contained) ──

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };

function jsonRes(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(data));
}

function parseProject(projectDir, fallbackName) {
  const tomlPath = path.join(projectDir, 'wrangler.toml');
  if (!fs.existsSync(tomlPath)) return null;
  try {
    const toml        = fs.readFileSync(tomlPath, 'utf8');
    const nameMatch   = toml.match(/^name\s*=\s*["']?([^"'\n]+)["']?/m);
    const bucketMatch = toml.match(/bucket\s*=\s*["']?([^"'\n]+)["']?/m);
    const name        = nameMatch ? nameMatch[1].trim() : fallbackName;

    const environments = [...toml.matchAll(/^\[env\.(\w+)\]/gm)].map(m => m[1]);
    const env          = environments[0] || 'production';

    const bucketDir = bucketMatch ? path.resolve(projectDir, bucketMatch[1].trim()) : null;
    const publicDir = path.join(projectDir, 'public');
    const htmlRoot  = (bucketDir && fs.existsSync(bucketDir))
      ? bucketDir : fs.existsSync(publicDir) ? publicDir : projectDir;

    const seenPaths = new Set();
    const files     = [];
    const SRC_EXTS  = new Set(['.js', '.ts', '.mjs', '.css']);

    function addFile(absPath, displayName) {
      if (seenPaths.has(absPath)) return;
      try { if (!fs.statSync(absPath).isFile()) return; } catch { return; }
      seenPaths.add(absPath);
      files.push({ name: displayName, path: absPath, ext: path.extname(absPath).slice(1).toLowerCase() });
    }

    try {
      fs.readdirSync(htmlRoot).filter(f => f.endsWith('.html'))
        .forEach(f => addFile(path.join(htmlRoot, f), f));
    } catch {}
    const srcDir = path.join(projectDir, 'src');
    if (fs.existsSync(srcDir)) {
      try {
        fs.readdirSync(srcDir, { withFileTypes: true })
          .filter(e => e.isFile() && (SRC_EXTS.has(path.extname(e.name).toLowerCase()) || e.name.endsWith('.html')))
          .forEach(e => addFile(path.join(srcDir, e.name), 'src/' + e.name));
      } catch {}
    }
    try {
      fs.readdirSync(projectDir, { withFileTypes: true })
        .filter(e => e.isFile() && SRC_EXTS.has(path.extname(e.name).toLowerCase()))
        .forEach(e => addFile(path.join(projectDir, e.name), e.name));
    } catch {}
    addFile(tomlPath, 'wrangler.toml');

    const htmlFiles = files.filter(f => f.ext === 'html');
    return { name, folderName: path.basename(projectDir), path: projectDir, htmlRoot, env, environments, files, htmlFiles };
  } catch { return null; }
}

function scanProjects(rootDir) {
  try {
    const projects = [], seen = new Set();
    function add(dir, name) {
      if (seen.has(dir)) return;
      const p = parseProject(dir, name);
      if (p) { seen.add(dir); projects.push(p); }
    }
    add(rootDir, path.basename(rootDir));
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const sub = path.join(rootDir, e.name);
      add(sub, e.name);
      try {
        for (const c of fs.readdirSync(sub, { withFileTypes: true })) {
          if (!c.isDirectory() || c.name.startsWith('.') || c.name === 'node_modules') continue;
          add(path.join(sub, c.name), c.name);
        }
      } catch {}
    }
    return projects;
  } catch (e) { return { error: e.message }; }
}

function startServer() {
  if (serverStarted) return;
  serverStarted = true;

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    const url   = new URL(req.url, `http://localhost:${PORT}`);
    const route = url.pathname;

    if (route === '/' || route === '/index.html') {
      const f = path.join(__dirname, '..', 'index.html');
      try { res.writeHead(200, {'Content-Type':'text/html'}); res.end(fs.readFileSync(f)); }
      catch { res.writeHead(404); res.end('not found'); }
      return;
    }

    if (route === '/api/scan' && req.method === 'GET') {
      const root = url.searchParams.get('root');
      if (!root) return jsonRes(res, { error: 'root param required' }, 400);
      const expanded = root.replace(/^~/, os.homedir()).trim();
      if (!fs.existsSync(expanded)) return jsonRes(res, { error: `Directory not found: "${expanded}"` }, 404);
      if (!fs.statSync(expanded).isDirectory()) return jsonRes(res, { error: `"${expanded}" is a file, not a folder.` }, 400);
      return jsonRes(res, scanProjects(expanded));
    }

    if (route === '/api/diagnose' && req.method === 'GET') {
      const root = url.searchParams.get('root');
      if (!root) return jsonRes(res, { error: 'root param required' }, 400);
      const expanded = root.replace(/^~/, os.homedir()).trim();
      if (!fs.existsSync(expanded)) return jsonRes(res, { exists: false, expanded });
      try {
        const entries  = fs.readdirSync(expanded, { withFileTypes: true });
        const children = entries.map(e => {
          const p = path.join(expanded, e.name);
          return { name: e.name, isDir: e.isDirectory(), hasToml: e.isDirectory() && fs.existsSync(path.join(p, 'wrangler.toml')) };
        });
        return jsonRes(res, { exists: true, expanded, selfHasToml: fs.existsSync(path.join(expanded, 'wrangler.toml')), children });
      } catch (e) { return jsonRes(res, { error: e.message }, 500); }
    }

    if (route === '/api/file' && req.method === 'GET') {
      const f = url.searchParams.get('path');
      if (!f || !fs.existsSync(f)) return jsonRes(res, { error: 'File not found' }, 404);
      try { return jsonRes(res, { content: fs.readFileSync(f, 'utf8') }); }
      catch (e) { return jsonRes(res, { error: e.message }, 500); }
    }

    if (route === '/api/file' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const { path: fp, content } = JSON.parse(body);
          if (!fp) return jsonRes(res, { error: 'path required' }, 400);
          fs.writeFileSync(fp, content, 'utf8');
          return jsonRes(res, { ok: true });
        } catch (e) { return jsonRes(res, { error: e.message }, 500); }
      });
      return;
    }

    if (route === '/api/new-file' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const { dir, filename } = JSON.parse(body);
          const publicDir = path.join(dir, 'public');
          const targetDir = fs.existsSync(publicDir) ? publicDir : dir;
          const fp = path.join(targetDir, filename);
          if (fs.existsSync(fp)) return jsonRes(res, { error: 'File already exists' }, 409);
          fs.writeFileSync(fp, '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>New Page</title>\n</head>\n<body>\n  \n</body>\n</html>', 'utf8');
          return jsonRes(res, { ok: true, path: fp });
        } catch (e) { return jsonRes(res, { error: e.message }, 500); }
      });
      return;
    }

    if (route === '/api/deploy-stream' && req.method === 'GET') {
      const projectPath = url.searchParams.get('projectPath');
      const id          = url.searchParams.get('id');
      if (!projectPath || !id) return jsonRes(res, { error: 'projectPath and id required' }, 400);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', ...CORS });
      const send = (type, data) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
      const env = url.searchParams.get('env') || '';
      send('start', `Starting wrangler deploy in ${projectPath}${env ? ` (env: ${env})` : ''}`);
      const deployCmd = env ? `npx wrangler deploy --env ${env}` : 'npx wrangler deploy';
      const userShell = process.env.SHELL || '/bin/zsh';
      const child = spawn(userShell, ['-l', '-c', deployCmd], {
        cwd: projectPath,
        env: { ...process.env, HOME: os.homedir(), NO_COLOR: '1' },
      });
      child.stdout.on('data', d => send('stdout', d.toString()));
      child.stderr.on('data', d => send('stderr', d.toString()));
      child.on('close', code => { send('done', code === 0 ? 'Deploy completed successfully.' : `Deploy exited with code ${code}`); res.end(); });
      child.on('error', err => { send('error', err.message); res.end(); });
      req.on('close', () => child.kill());
      return;
    }

    if (route === '/api/tail-stream' && req.method === 'GET') {
      const projectPath = url.searchParams.get('projectPath');
      const id          = url.searchParams.get('id');
      const env         = url.searchParams.get('env') || '';
      if (!projectPath || !id) return jsonRes(res, { error: 'projectPath and id required' }, 400);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', ...CORS });
      const send = (type, data) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
      send('start', `Connecting to wrangler tail${env ? ` --env ${env}` : ''}…`);
      const tailCmd = env ? `npx wrangler tail --env ${env}` : 'npx wrangler tail';
      const child = spawn(process.env.SHELL || '/bin/zsh', ['-l', '-c', tailCmd], {
        cwd: projectPath,
        env: { ...process.env, HOME: os.homedir(), NO_COLOR: '1' },
      });
      child.stdout.on('data', d => send('stdout', d.toString()));
      child.stderr.on('data', d => send('stderr', d.toString()));
      child.on('close', code => { send('done', `Tail stopped${code && code !== 0 ? ` (code ${code})` : ''}`); res.end(); });
      child.on('error', err => { send('error', err.message); res.end(); });
      req.on('close', () => child.kill());
      return;
    }

    res.writeHead(404, CORS); res.end('Not found');
  });

  server.listen(PORT, '127.0.0.1', () => console.log(`Server running on port ${PORT}`));
  server.on('error', e => console.error('Server error:', e));
}

// ── IPC: native folder picker ──────────────────────────────────────────────
ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Wrangler projects folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── Window ─────────────────────────────────────────────────────────────────
function createWindow() {
  startServer();

  mainWindow = new BrowserWindow({
    width:  1280,
    height: 820,
    minWidth:  900,
    minHeight: 600,
    title: 'Wrangler Manager',
    backgroundColor: '#13131a',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    titleBarStyle: 'default',
    frame: true,
    ...(fs.existsSync(path.join(__dirname, 'icon.png')) && { icon: path.join(__dirname, 'icon.png') }),
  });

  // Poll until the server is actually listening before loading
  function loadWhenReady(attempts) {
    http.get(`http://localhost:${PORT}/`, res => {
      mainWindow.loadURL(`http://localhost:${PORT}`);
    }).on('error', () => {
      if (attempts > 0) setTimeout(() => loadWhenReady(attempts - 1), 100);
      else mainWindow.loadURL(`http://localhost:${PORT}`); // try anyway
    });
  }
  loadWhenReady(20);

  mainWindow.on('closed', () => { mainWindow = null; });
}


// ── Application menu with custom About ────────────────────────────────────
function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        {
          label: 'About Wrangler Manager',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Wrangler Manager',
              message: 'Wrangler Manager',
              detail: [
                'Version 1.2.0',
                '',
                'A desktop IDE for editing and deploying',
                'Cloudflare Workers (Wrangler) projects.',
                '',
                'Copyright © 2026 Nicholas Percoco',
                'Licensed under the MIT License.',
                '',
                'Built with Electron and CodeMirror.',
              ].join('\n'),
              buttons: ['OK'],
            });
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => { buildMenu(); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });
