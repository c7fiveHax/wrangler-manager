#!/usr/bin/env node
/**
 * Wrangler Manager - Local Server
 * Run: node server.js
 * Then open: http://localhost:3474
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const os   = require('os');

const PORT = 3474;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };

// Active SSE clients keyed by a deploy ID
const sseClients = new Map();

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

// Parse a wrangler.toml and return project metadata
function parseProject(projectDir, fallbackName) {
  const tomlPath = path.join(projectDir, 'wrangler.toml');
  if (!fs.existsSync(tomlPath)) return null;
  try {
    const toml      = fs.readFileSync(tomlPath, 'utf8');
    const nameMatch = toml.match(/^name\s*=\s*["']?([^"'\n]+)["']?/m);
    const name      = nameMatch ? nameMatch[1].trim() : fallbackName;

    // All named environments from [env.X] sections
    const environments = [...toml.matchAll(/^\[env\.(\w+)\]/gm)].map(m => m[1]);
    const env          = environments[0] || 'production';

    // HTML root (bucket → public → project root)
    const bucketMatch = toml.match(/bucket\s*=\s*["']?([^"'\n]+)["']?/m);
    const bucketDir   = bucketMatch ? path.resolve(projectDir, bucketMatch[1].trim()) : null;
    const publicDir   = path.join(projectDir, 'public');
    const htmlRoot    = (bucketDir && fs.existsSync(bucketDir))
      ? bucketDir : fs.existsSync(publicDir) ? publicDir : projectDir;

    // Collect all editable files
    const seenPaths = new Set();
    const files     = [];
    const SRC_EXTS  = new Set(['.js', '.ts', '.mjs', '.css']);

    function addFile(absPath, displayName) {
      if (seenPaths.has(absPath)) return;
      try { if (!fs.statSync(absPath).isFile()) return; } catch { return; }
      seenPaths.add(absPath);
      files.push({ name: displayName, path: absPath, ext: path.extname(absPath).slice(1).toLowerCase() });
    }

    // HTML files first
    try {
      fs.readdirSync(htmlRoot).filter(f => f.endsWith('.html'))
        .forEach(f => addFile(path.join(htmlRoot, f), f));
    } catch {}
    // src/ directory
    const srcDir = path.join(projectDir, 'src');
    if (fs.existsSync(srcDir)) {
      try {
        fs.readdirSync(srcDir, { withFileTypes: true })
          .filter(e => e.isFile() && (SRC_EXTS.has(path.extname(e.name).toLowerCase()) || e.name.endsWith('.html')))
          .forEach(e => addFile(path.join(srcDir, e.name), 'src/' + e.name));
      } catch {}
    }
    // Root-level source files
    try {
      fs.readdirSync(projectDir, { withFileTypes: true })
        .filter(e => e.isFile() && SRC_EXTS.has(path.extname(e.name).toLowerCase()))
        .forEach(e => addFile(path.join(projectDir, e.name), e.name));
    } catch {}
    // wrangler.toml last
    addFile(tomlPath, 'wrangler.toml');

    const htmlFiles = files.filter(f => f.ext === 'html');
    return { name, folderName: path.basename(projectDir), path: projectDir, htmlRoot, env, environments, files, htmlFiles };
  } catch (e) {
    return null;
  }
}

// Scan a root directory for Wrangler projects.
// Handles three cases:
//   1. The root itself is a wrangler project (has wrangler.toml directly)
//   2. Direct subfolders of root are wrangler projects (the normal case)
//   3. One level deeper (grandchildren) — for monorepo-style layouts
function scanProjects(rootDir) {
  try {
    const projects = [];
    const seen     = new Set();

    function addProject(dir, name) {
      if (seen.has(dir)) return;
      const p = parseProject(dir, name);
      if (p) { seen.add(dir); projects.push(p); }
    }

    // Case 1: root itself
    addProject(rootDir, path.basename(rootDir));

    // Case 2 & 3: walk subdirectories
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const sub = path.join(rootDir, entry.name);
      addProject(sub, entry.name);

      // Case 3: one level deeper
      try {
        const subEntries = fs.readdirSync(sub, { withFileTypes: true });
        for (const child of subEntries) {
          if (!child.isDirectory() || child.name.startsWith('.') || child.name === 'node_modules') continue;
          addProject(path.join(sub, child.name), child.name);
        }
      } catch {}
    }

    return projects;
  } catch (e) {
    return { error: e.message };
  }
}

const server = http.createServer((req, res) => {
  // Preflight
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  const url   = new URL(req.url, `http://localhost:${PORT}`);
  const route = url.pathname;

  // Serve frontend
  if (route === '/' || route === '/index.html') {
    return serveFile(res, path.join(__dirname, 'index.html'));
  }

  // --- API ---

  // GET /api/scan?root=/path/to/projects
  if (route === '/api/scan' && req.method === 'GET') {
    const root = url.searchParams.get('root');
    if (!root) return json(res, { error: 'root param required' }, 400);
    const expanded = root.replace(/^~/, os.homedir()).trim();
    if (!fs.existsSync(expanded)) return json(res, { error: `Directory not found: "${expanded}". Check the path and try again.` }, 404);
    if (!fs.statSync(expanded).isDirectory()) return json(res, { error: `"${expanded}" is a file, not a folder.` }, 400);
    return json(res, scanProjects(expanded));
  }

  // GET /api/diagnose?root=/path  — lists what the server actually sees
  if (route === '/api/diagnose' && req.method === 'GET') {
    const root = url.searchParams.get('root');
    if (!root) return json(res, { error: 'root param required' }, 400);
    const expanded = root.replace(/^~/, os.homedir()).trim();
    const exists = fs.existsSync(expanded);
    if (!exists) return json(res, { exists: false, expanded });
    try {
      const entries = fs.readdirSync(expanded, { withFileTypes: true });
      const children = entries.map(e => {
        const p = require('path').join(expanded, e.name);
        const hasToml = e.isDirectory() && fs.existsSync(require('path').join(p, 'wrangler.toml'));
        return { name: e.name, isDir: e.isDirectory(), hasToml };
      });
      const selfToml = fs.existsSync(require('path').join(expanded, 'wrangler.toml'));
      return json(res, { exists: true, expanded, selfHasToml: selfToml, children });
    } catch (e) { return json(res, { error: e.message }, 500); }
  }

  // GET /api/file?path=/abs/path/to/file.html
  if (route === '/api/file' && req.method === 'GET') {
    const filePath = url.searchParams.get('path');
    if (!filePath || !fs.existsSync(filePath)) return json(res, { error: 'File not found' }, 404);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return json(res, { content });
    } catch (e) { return json(res, { error: e.message }, 500); }
  }

  // POST /api/file  body: { path, content }
  if (route === '/api/file' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { path: filePath, content } = JSON.parse(body);
        if (!filePath) return json(res, { error: 'path required' }, 400);
        fs.writeFileSync(filePath, content, 'utf8');
        return json(res, { ok: true });
      } catch (e) { return json(res, { error: e.message }, 500); }
    });
    return;
  }

  // POST /api/new-file  body: { dir, filename }
  if (route === '/api/new-file' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { dir, filename } = JSON.parse(body);
        // Always create new files inside /public if it exists, matching project structure
        const publicDir = path.join(dir, 'public');
        const targetDir = fs.existsSync(publicDir) ? publicDir : dir;
        const filePath = path.join(targetDir, filename);
        if (fs.existsSync(filePath)) return json(res, { error: 'File already exists' }, 409);
        fs.writeFileSync(filePath, '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>New Page</title>\n</head>\n<body>\n  \n</body>\n</html>', 'utf8');
        return json(res, { ok: true, path: filePath });
      } catch (e) { return json(res, { error: e.message }, 500); }
    });
    return;
  }

  // GET /api/preview?path=/abs/path/to/file.html
  // Opens the file in the default browser
  if (route === '/api/preview' && req.method === 'GET') {
    const filePath = url.searchParams.get('path');
    if (!filePath || !fs.existsSync(filePath)) return json(res, { error: 'File not found' }, 404);
    try {
      const platform = process.platform;
      if (platform === 'darwin')  execSync(`open -a "Google Chrome" "${filePath}"`);
      else if (platform === 'win32') execSync(`start chrome "${filePath}"`);
      else execSync(`google-chrome "${filePath}" || chromium-browser "${filePath}"`);
      return json(res, { ok: true });
    } catch (e) {
      // Fallback: open with system default browser
      try {
        if (process.platform === 'darwin') execSync(`open "${filePath}"`);
        else if (process.platform === 'win32') execSync(`start "${filePath}"`);
        else execSync(`xdg-open "${filePath}"`);
        return json(res, { ok: true, fallback: true });
      } catch (e2) { return json(res, { error: e2.message }, 500); }
    }
  }

  // GET /api/deploy-stream?projectPath=/path&id=abc
  // Server-Sent Events stream for wrangler deploy output
  if (route === '/api/deploy-stream' && req.method === 'GET') {
    const projectPath = url.searchParams.get('projectPath');
    const id          = url.searchParams.get('id');
    if (!projectPath || !id) return json(res, { error: 'projectPath and id required' }, 400);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...CORS
    });

    const send = (type, data) => {
      res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };

    const env = url.searchParams.get('env') || '';
    send('start', `Starting wrangler deploy in ${projectPath}${env ? ` (env: ${env})` : ''}`);

    const deployCmd = env ? `npx wrangler deploy --env ${env}` : 'npx wrangler deploy';
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-l', '-c', deployCmd], {
      cwd: projectPath,
      env: { ...process.env, NO_COLOR: '1' }
    });

    child.stdout.on('data', d => send('stdout', d.toString()));
    child.stderr.on('data', d => send('stderr', d.toString()));
    child.on('close', code => {
      send('done', code === 0 ? 'Deploy completed successfully.' : `Deploy exited with code ${code}`);
      res.end();
      sseClients.delete(id);
    });
    child.on('error', err => {
      send('error', err.message);
      res.end();
    });

    sseClients.set(id, child);

    req.on('close', () => {
      child.kill();
      sseClients.delete(id);
    });
    return;
  }

  // GET /api/tail-stream?projectPath=/path&id=abc[&env=staging]
  if (route === '/api/tail-stream' && req.method === 'GET') {
    const projectPath = url.searchParams.get('projectPath');
    const id          = url.searchParams.get('id');
    const env         = url.searchParams.get('env') || '';
    if (!projectPath || !id) return json(res, { error: 'projectPath and id required' }, 400);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...CORS
    });

    const send = (type, data) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    send('start', `Connecting to wrangler tail${env ? ` --env ${env}` : ''}…`);

    const tailCmd = env ? `npx wrangler tail --env ${env}` : 'npx wrangler tail';
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-l', '-c', tailCmd], {
      cwd: projectPath,
      env: { ...process.env, NO_COLOR: '1' }
    });

    child.stdout.on('data', d => send('stdout', d.toString()));
    child.stderr.on('data', d => send('stderr', d.toString()));
    child.on('close', code => {
      send('done', `Tail stopped${code && code !== 0 ? ` (code ${code})` : ''}`);
      res.end();
      sseClients.delete(id);
    });
    child.on('error', err => { send('error', err.message); res.end(); });

    sseClients.set(id, child);
    req.on('close', () => { child.kill(); sseClients.delete(id); });
    return;
  }

  // 404
  res.writeHead(404, CORS);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n✓ Wrangler Manager running at http://localhost:${PORT}\n`);
  // Auto-open in default browser
  try {
    if (process.platform === 'darwin')       execSync(`open http://localhost:${PORT}`);
    else if (process.platform === 'win32')   execSync(`start http://localhost:${PORT}`);
    else                                      execSync(`xdg-open http://localhost:${PORT}`);
  } catch {}
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`\nPort ${PORT} is already in use. Is the server already running?\n`);
  else console.error(e);
});
