// Async fs reads against a cloud-synced (e.g. Dropbox) notes folder can stall on
// hydration; a bigger libuv pool keeps a few stuck reads from starving all fs work.
// Must be set before the threadpool is first used.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const { app, BrowserWindow, ipcMain, dialog, nativeImage, Menu, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os'); // Added for temp file handling

const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const crypto = require('crypto');

const fsp = fs.promises;

// Timeouts for file operations against the notes folder. Cloud-synced files
// (Dropbox online-only placeholders) can stall indefinitely on read when offline.
const FILE_OP_TIMEOUT_MS = 5000;    // per-file ops during a folder scan
const LAZY_READ_TIMEOUT_MS = 15000; // single-file reads (image/audio/canvas)

// Cooperative cancellation for long jobs (Import from IC "Stop").
function cancelledError() {
  const e = new Error('Stopped');
  e.code = 'CANCELLED';
  return e;
}
function isCancelled(e) {
  return !!(e && e.code === 'CANCELLED');
}
function throwIfAborted(signal) {
  if (signal && signal.aborted) throw cancelledError();
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'File operation'} timed out after ${ms}ms (file may be online-only)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// macOS File Provider (Dropbox/iCloud) online-only placeholders are "dataless":
// stat succeeds instantly from local metadata but zero blocks are allocated.
// Caveat: a legitimately sparse file also reports blocks === 0 and would be
// flagged unavailable — essentially never true for notes, so acceptable.
function isDatalessPlaceholder(stats) {
  return process.platform === 'darwin' && stats.size > 0 && stats.blocks === 0;
}

// A dataless file is only truly unavailable when there is no internet: with
// connectivity, reading it just triggers an on-demand download (hydration).
function isNetworkOffline() {
  try {
    return !net.isOnline();
  } catch (_e) {
    return false; // if in doubt, assume online and attempt the read
  }
}

// Run fn over items with at most `limit` in flight at once.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// Simple counting semaphore: `const release = await acquire(); try {...} finally { release(); }`
function makeSemaphore(max) {
  let active = 0;
  const waiters = [];
  const release = () => {
    const next = waiters.shift();
    if (next) next(); else active--;
  };
  return async () => {
    if (active < max) { active++; return release; }
    await new Promise((resolve) => waiters.push(resolve));
    return release;
  };
}

// All app-generated sidecar files (canvas, image/audio attachments, format
// spans) live in a hidden subfolder so the notes folder holds only .txt files.
const NOATFORMAT_DIR = '.noatformat';
const IMG_RE = /\.(png|jpg|jpeg|gif|webp)$/i;
const AUDIO_RE = /\.(mp3|wav|aiff|aif|ogg|m4a|flac|wma)$/i;

// Classify a sidecar filename -> { baseKey, kind } or null for non-sidecars.
// Canvas suffixes must be checked before generic image extensions so
// "x.canvas.png" yields base "x", not "x.canvas". baseKey is lowercased to
// match the renderer's attachment matching (and APFS case-insensitivity).
function sidecarInfo(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.canvas.json')) return { baseKey: lower.slice(0, -'.canvas.json'.length), kind: 'canvas' };
  if (lower.endsWith('.canvas.png')) return { baseKey: lower.slice(0, -'.canvas.png'.length), kind: 'canvasPng' };
  const imgMatch = lower.match(IMG_RE);
  if (imgMatch) {
    // Legacy ".nvimg." marker names attach to the note before the marker.
    const nvimg = lower.lastIndexOf('.nvimg.');
    if (nvimg >= 0) return { baseKey: lower.slice(0, nvimg), kind: 'image' };
    return { baseKey: lower.slice(0, -imgMatch[0].length), kind: 'image' };
  }
  const audMatch = lower.match(AUDIO_RE);
  if (audMatch) return { baseKey: lower.slice(0, -audMatch[0].length), kind: 'audio' };
  return null;
}

let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');

  // When packaged with asar, binaries must be read from app.asar.unpacked.
  // ffmpeg-static may still resolve a path under app.asar, which is not executable and can throw ENOTDIR.
  if (ffmpegPath && typeof ffmpegPath === 'string' && ffmpegPath.includes('app.asar')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }

  // Ensure the binary is executable on macOS/Linux.
  if (ffmpegPath && process.platform !== 'win32') {
    try { fs.chmodSync(ffmpegPath, 0o755); } catch (_e) {}
  }
} catch (e) {
  console.warn('ffmpeg-static not available; audio transcoding disabled.');
}

// Lazily created cache dir for transcoded audio
function getAudioCacheDir() {
  const dir = path.join(app.getPath('userData'), 'audio-cache');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_e) {}
  return dir;
}

function getFileSignature(p) {
  try {
    const st = fs.statSync(p);
    return `${st.size}|${st.mtimeMs}`;
  } catch (_e) {
    return '0|0';
  }
}

function getCachedAudioPath(inputPath, outExt) {
  const sig = getFileSignature(inputPath);
  const key = crypto.createHash('sha1').update(`${inputPath}|${sig}`).digest('hex');
  return path.join(getAudioCacheDir(), `${key}.${outExt}`);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg not available'));
      return;
    }
    if (!fs.existsSync(ffmpegPath)) {
      reject(new Error(`ffmpeg binary not found: ${ffmpegPath}`));
      return;
    }
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', (err) => reject(new Error(`${err.message} (ffmpegPath=${ffmpegPath})`)));
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error((stderr || '').trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

async function transcodeToWavCached(inputPath) {
  const outPath = getCachedAudioPath(inputPath, 'wav');
  if (fs.existsSync(outPath)) return outPath;

  // -vn to ignore video streams, force stereo and 44.1kHz for predictable playback
  await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath, '-vn', '-ac', '2', '-ar', '44100', '-f', 'wav', outPath]);
  return outPath;
}

async function transcodeToMp3DataUrl(inputPath, bitrateKbps = 128) {
  const outPath = getCachedAudioPath(inputPath, 'mp3');
  if (!fs.existsSync(outPath)) {
    await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath, '-vn', '-ac', '2', '-ar', '44100', '-b:a', `${bitrateKbps}k`, '-f', 'mp3', outPath]);
  }
  const buf = fs.readFileSync(outPath);
  const b64 = buf.toString('base64');
  return { path: outPath, dataUrl: `data:audio/mpeg;base64,${b64}` };
}

// ---------------------------------------------------------------------------
// DeepSeek (OpenAI-compatible chat completions). Single shared helper used by
// both the auto-fix feature and the IC recorder import so the API key is only
// ever used from the main process.
const DEEPSEEK_MODEL = 'deepseek-flash';
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';

async function callDeepSeek({ apiKey, system, user, temperature = 0.2, maxTokens = 4096, timeoutMs = 180000, thinking = false, signal = null }) {
  if (!apiKey) throw new Error('DeepSeek API key is not set');
  throwIfAborted(signal);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => { try { controller.abort(); } catch (_e) {} };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let res;
  try {
    res = await fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: system || '' },
          { role: 'user', content: user || '' }
        ],
        temperature,
        max_tokens: maxTokens,
        // Thinking mode is on by default and its reasoning tokens count against
        // max_tokens, which left long transcripts with an empty reply. These
        // editing tasks do not need it.
        thinking: { type: thinking ? 'enabled' : 'disabled' }
      }),
      signal: controller.signal
    });
  } catch (e) {
    if (signal && signal.aborted) throw cancelledError();
    if (e && e.name === 'AbortError') throw new Error(`DeepSeek request timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw new Error(`DeepSeek request failed: ${e.message || e}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  const bodyText = await res.text();
  throwIfAborted(signal);
  let data = null;
  try { data = JSON.parse(bodyText); } catch (_e) {}

  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || bodyText.slice(0, 200) || res.statusText;
    throw new Error(`DeepSeek ${res.status}: ${msg}`);
  }
  const choice = data && data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  const reason = (choice && choice.finish_reason) || 'unknown';
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(`DeepSeek returned no text (finish_reason: ${reason})`);
  }
  if (reason === 'length') {
    // The reply hit max_tokens and is cut off. Callers may retry with a
    // bigger budget; never silently accept a truncated edit.
    const err = new Error(`DeepSeek reply was cut off at ${maxTokens} tokens (finish_reason: length)`);
    err.code = 'DEEPSEEK_TRUNCATED';
    err.partialContent = content;
    throw err;
  }
  return content;
}

// Note: MP3 encoding is done in the renderer process using vendored lamejs (lame.min.js)

// Config file path for storing preferences (like last folder)
const configPath = path.join(app.getPath('userData'), 'config.json');

// Local LLM support
let llamaModule = null;
let llamaInstance = null;
let currentModel = null;
let currentModelPath = null;

let mainWindow;

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading config:', e);
  }
  return {};
}

function saveConfig(config) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving config:', e);
  }
}

function createMenu() {
  const isMac = process.platform === 'darwin';
  
  const template = [
    // App menu (macOS only)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences...',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            mainWindow.webContents.send('open-preferences');
          }
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    // File menu
    {
      label: 'File',
      submenu: [
        ...(!isMac ? [{
          label: 'Preferences...',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            mainWindow.webContents.send('open-preferences');
          }
        },
        { type: 'separator' }] : []),
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    // View menu
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' }
        ] : [
          { role: 'close' }
        ])
      ]
    }
  ];
  
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  const isWindows = process.platform === 'win32';
  
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    fullscreen: !isWindows,
    simpleFullscreen: isWindows,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    icon: path.join(__dirname, 'icon.png'),
    title: 'Noat Boat'
  });


  createMenu();
  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    const isWindows = process.platform === 'win32';
    // Ensure app menu (and its shortcuts like Cmd/Ctrl+,) exists
    mainWindow.setMenuBarVisibility(true);
    // On Windows, use maximize for simpleFullscreen; on macOS use true fullscreen
    if (isWindows) {
      mainWindow.maximize();
    } else {
      mainWindow.setFullScreen(true);
    }
    mainWindow.show();
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  // Clean up local LLM model
  if (currentModel) {
    try {
      if (currentModel.model) await currentModel.model.dispose();
    } catch (e) {
      console.error('Error disposing model on quit:', e);
    }
    currentModel = null;
    currentModelPath = null;
  }
});

// ============ IPC Handlers ============

// Get saved folder path
ipcMain.handle('get-saved-folder', async () => {
  const config = loadConfig();
  return config.lastFolder || null;
});

// Save folder path to config
ipcMain.handle('save-folder-path', async (event, folderPath) => {
  const config = loadConfig();
  config.lastFolder = folderPath;
  saveConfig(config);
  return true;
});

// Get preferences
ipcMain.handle('get-preferences', async () => {
  const config = loadConfig();
  // One-time migration: OpenAI was replaced by DeepSeek as the cloud provider.
  if (config.autoFixProvider === 'openai' || config.openAIKey !== undefined) {
    if (config.autoFixProvider === 'openai') config.autoFixProvider = 'deepseek';
    delete config.openAIKey;
    saveConfig(config);
  }
  return {
    theme: config.theme || 'light',
    focusStrength: config.focusStrength !== undefined ? config.focusStrength : 70,
    autoFixMode: config.autoFixMode || 'off',
    autoFixEnabled: config.autoFixEnabled || false, // Legacy support
    autoFixProvider: config.autoFixProvider || 'deepseek',
    deepseekKey: config.deepseekKey || '',
    localModelPath: config.localModelPath || '',
    whisperCliPath: config.whisperCliPath || '',
    whisperModelPath: config.whisperModelPath || '',
    icNotesFolder: config.icNotesFolder || '',
    githubToken: config.githubToken || '',
    githubRepo: config.githubRepo || '',
    publishingName: config.publishingName || '',
    publishedSiteUrl: config.publishedSiteUrl || '',
    bitcoinTipAddress: config.bitcoinTipAddress || '',
    ethereumTipAddress: config.ethereumTipAddress || ''
  };
});

// Save preferences
ipcMain.handle('save-preferences', async (event, prefs) => {
  const config = loadConfig();
  if (prefs.theme !== undefined) config.theme = prefs.theme;
  if (prefs.focusStrength !== undefined) config.focusStrength = prefs.focusStrength;
  if (prefs.autoFixMode !== undefined) config.autoFixMode = prefs.autoFixMode;
  if (prefs.autoFixProvider !== undefined) config.autoFixProvider = prefs.autoFixProvider;
  if (prefs.deepseekKey !== undefined) config.deepseekKey = prefs.deepseekKey;
  if (prefs.localModelPath !== undefined) config.localModelPath = prefs.localModelPath;
  if (prefs.whisperCliPath !== undefined) config.whisperCliPath = prefs.whisperCliPath;
  if (prefs.whisperModelPath !== undefined) config.whisperModelPath = prefs.whisperModelPath;
  if (prefs.icNotesFolder !== undefined) config.icNotesFolder = prefs.icNotesFolder;
  if (prefs.githubToken !== undefined) config.githubToken = prefs.githubToken;
  if (prefs.githubRepo !== undefined) config.githubRepo = prefs.githubRepo;
  if (prefs.publishingName !== undefined) config.publishingName = prefs.publishingName;
  if (prefs.publishedSiteUrl !== undefined) config.publishedSiteUrl = prefs.publishedSiteUrl;
  if (prefs.bitcoinTipAddress !== undefined) config.bitcoinTipAddress = prefs.bitcoinTipAddress;
  if (prefs.ethereumTipAddress !== undefined) config.ethereumTipAddress = prefs.ethereumTipAddress;
  saveConfig(config);
  return true;
});

// Open folder picker dialog
ipcMain.handle('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  
  return result.filePaths[0];
});

// Read all files from a folder (now includes subdirectories).
// Fully async with per-file timeouts and error isolation so a Dropbox
// online-only placeholder can never hang the app or abort the whole scan.
// Scan one folder (migration, sidecar matching, canvas-png attachment).
// Extracted from the read-folder handler so calendar-scan can reuse it;
// readContent:false skips reading .txt contents for lightweight scans.
async function scanFolder(folderPath, opts = {}) {
  const readContent = opts.readContent !== false;
  {
    const entries = await withTimeout(
      fsp.readdir(folderPath, { withFileTypes: true }), 10000, 'Listing folder');
    const files = [];
    const folders = [];
    let skippedCount = 0;
    const sidecarDir = path.join(folderPath, NOATFORMAT_DIR);
    // .canvas.png stats, keyed by lowercased base name; attached to the
    // matching canvas entries below so the renderer never has to stat them.
    const canvasPngs = new Map();

    // --- Phase 1: migrate legacy sidecars sitting next to notes into
    // .noatformat. Only files whose base matches an existing .txt note are
    // touched; unrelated user files stay put. Per-file failures (offline,
    // read-only, collision) leave the file in the root, which keeps working.
    const migrated = new Set();
    const txtBases = new Set(entries
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.txt'))
      .map(e => e.name.slice(0, -4).toLowerCase()));
    const toMigrate = entries.filter(e => {
      if (!e.isFile()) return false;
      const info = sidecarInfo(e.name);
      return info && txtBases.has(info.baseKey);
    });
    if (toMigrate.length > 0) {
      try {
        await withTimeout(fsp.mkdir(sidecarDir, { recursive: true }), FILE_OP_TIMEOUT_MS, NOATFORMAT_DIR);
        await mapLimit(toMigrate, 4, async (entry) => {
          const destPath = path.join(sidecarDir, entry.name);
          try {
            let destExists = true;
            try { await withTimeout(fsp.access(destPath), FILE_OP_TIMEOUT_MS, entry.name); }
            catch (_e) { destExists = false; }
            // Collision: never overwrite; the renderer picks the newest copy
            // and later saves/deletes converge on .noatformat.
            if (destExists) return;
            await withTimeout(fsp.rename(path.join(folderPath, entry.name), destPath), FILE_OP_TIMEOUT_MS, entry.name);
            migrated.add(entry.name);
          } catch (_e) { /* leave legacy file in the root */ }
        });
      } catch (_e) { /* mkdir failed (offline/read-only): keep legacy layout */ }
    }

    // Dataless (online-only) files are only skipped when there is no
    // connectivity; when online, reading them hydrates on demand.
    const offline = isNetworkOffline();

    // --- Phase 2: scan the notes folder itself ---
    const results = await mapLimit(entries, 8, async (entry) => {
      if (migrated.has(entry.name)) return null; // now lives in .noatformat
      const fullPath = path.join(folderPath, entry.name);
      try {
        // Handle directories
        if (entry.isDirectory()) {
          // Skip hidden folders (starting with .)
          if (entry.name.startsWith('.')) return null;

          const stats = await withTimeout(fsp.stat(fullPath), FILE_OP_TIMEOUT_MS, entry.name);
          return {
            kind: 'folder',
            item: {
              name: entry.name,
              type: 'folder',
              path: fullPath,
              lastModified: stats.mtimeMs
            }
          };
        }

        if (!entry.isFile()) return null;

        const stats = await withTimeout(fsp.stat(fullPath), FILE_OP_TIMEOUT_MS, entry.name);
        const lower = entry.name.toLowerCase();
        const dataless = isDatalessPlaceholder(stats);
        const unavailable = (dataless && offline) || undefined;

        if (lower.endsWith('.txt')) {
          if (unavailable) {
            return {
              kind: 'file',
              item: {
                name: entry.name,
                type: 'text',
                path: fullPath,
                content: '',
                size: stats.size,
                created: stats.birthtimeMs,
                lastModified: stats.mtimeMs,
                unavailable: true
              }
            };
          }
          // A dataless read triggers a download, so give it the longer timeout.
          const content = readContent
            ? await withTimeout(fsp.readFile(fullPath, 'utf8'), dataless ? LAZY_READ_TIMEOUT_MS : FILE_OP_TIMEOUT_MS, entry.name)
            : '';
          return {
            kind: 'file',
            item: {
              name: entry.name,
              type: 'text',
              path: fullPath,
              content: content,
              size: stats.size,
              created: stats.birthtimeMs,
              lastModified: stats.mtimeMs
            }
          };
        } else if (IMG_RE.test(entry.name) && !lower.endsWith('.canvas.png')) {
          return {
            kind: 'file',
            item: {
              name: entry.name,
              type: 'image',
              path: fullPath,
              size: stats.size,
              created: stats.birthtimeMs,
              lastModified: stats.mtimeMs,
              unavailable: unavailable
            }
          };
        } else if (AUDIO_RE.test(entry.name)) {
          return {
            kind: 'file',
            item: {
              name: entry.name,
              type: 'audio',
              path: fullPath,
              size: stats.size,
              created: stats.birthtimeMs,
              lastModified: stats.mtimeMs,
              unavailable: unavailable
            }
          };
        } else if (lower.endsWith('.canvas.json')) {
          return {
            kind: 'file',
            item: {
              name: entry.name,
              type: 'canvas',
              path: fullPath,
              size: stats.size,
              created: stats.birthtimeMs,
              lastModified: stats.mtimeMs,
              unavailable: unavailable
            }
          };
        } else if (lower.endsWith('.canvas.png')) {
          return {
            kind: 'canvasPng',
            item: { name: entry.name, path: fullPath, size: stats.size, unavailable: unavailable }
          };
        }
        return null;
      } catch (_e) {
        // Per-file failure (timeout, permissions, stalled hydration):
        // isolate it so the rest of the folder still loads.
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.txt')) {
          return {
            kind: 'file',
            item: {
              name: entry.name,
              type: 'text',
              path: fullPath,
              content: '',
              size: 0,
              created: 0,
              lastModified: 0,
              unavailable: true
            }
          };
        }
        return { kind: 'skipped' };
      }
    });

    for (const r of results) {
      if (!r) continue;
      if (r.kind === 'folder') {
        folders.push(r.item);
      } else if (r.kind === 'file') {
        files.push(r.item);
        if (r.item.unavailable) skippedCount++;
      } else if (r.kind === 'canvasPng') {
        const base = r.item.name.toLowerCase().slice(0, -'.canvas.png'.length);
        if (!canvasPngs.has(base)) canvasPngs.set(base, []);
        canvasPngs.get(base).push(r.item);
      } else {
        skippedCount++;
      }
    }

    // --- Phase 3: scan .noatformat for sidecars (images, audio, canvas).
    // Format-span files are read by explicit path elsewhere and not listed.
    try {
      const scEntries = await withTimeout(
        fsp.readdir(sidecarDir, { withFileTypes: true }), 10000, NOATFORMAT_DIR);
      const scResults = await mapLimit(scEntries, 8, async (entry) => {
        if (!entry.isFile()) return null;
        const lower = entry.name.toLowerCase();
        if (lower.endsWith('.format.json')) return null;
        const fullPath = path.join(sidecarDir, entry.name);
        try {
          const stats = await withTimeout(fsp.stat(fullPath), FILE_OP_TIMEOUT_MS, entry.name);
          const unavailable = (isDatalessPlaceholder(stats) && offline) || undefined;
          const common = {
            name: entry.name,
            path: fullPath,
            size: stats.size,
            created: stats.birthtimeMs,
            lastModified: stats.mtimeMs,
            unavailable: unavailable
          };
          if (lower.endsWith('.canvas.png')) return { ...common, type: 'canvasPng' };
          if (IMG_RE.test(entry.name)) return { ...common, type: 'image' };
          if (AUDIO_RE.test(entry.name)) return { ...common, type: 'audio' };
          if (lower.endsWith('.canvas.json')) return { ...common, type: 'canvas' };
          return null;
        } catch (_e) {
          return 'skipped';
        }
      });
      for (const r of scResults) {
        if (r === 'skipped') skippedCount++;
        else if (r && r.type === 'canvasPng') {
          const base = r.name.toLowerCase().slice(0, -'.canvas.png'.length);
          if (!canvasPngs.has(base)) canvasPngs.set(base, []);
          canvasPngs.get(base).push(r);
        } else if (r) {
          files.push(r);
          if (r.unavailable) skippedCount++;
        }
      }
    } catch (_e) { /* no .noatformat dir (or unreadable/offline): fine */ }

    // Attach the real .canvas.png path/size to each canvas entry so the
    // renderer can gate on size without any extra IPC round-trips.
    for (const f of files) {
      if (f.type !== 'canvas') continue;
      const base = f.name.toLowerCase().slice(0, -'.canvas.json'.length);
      const pngs = canvasPngs.get(base);
      if (!pngs || pngs.length === 0) continue;
      const dir = path.dirname(f.path);
      const match = pngs.find(p => path.dirname(p.path) === dir) || pngs[0];
      f.pngPath = match.path;
      f.pngSize = match.size;
    }

    return { files: files, folders: folders, skippedCount: skippedCount };
  }
}

ipcMain.handle('read-folder', async (event, folderPath) => {
  try {
    const r = await scanFolder(folderPath);
    return { success: true, files: r.files, folders: r.folders, skippedCount: r.skippedCount };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Recursive lightweight scan for the calendar view: every note in the tree
// with its timestamps and due date. No text content.
ipcMain.handle('calendar-scan', async (event, rootPath) => {
  try {
    const notesOut = [];
    async function walk(folder, depth) {
      if (depth > 12) return;
      let scan;
      try { scan = await scanFolder(folder, { readContent: false }); } catch (_e) { return; }

      await mapLimit(scan.files.filter(f => f.type === 'text'), 8, async (f) => {
        const title = f.name.replace(/\.txt$/i, '');

        let dueDate = null;
        try {
          const raw = await withTimeout(
            fsp.readFile(path.join(folder, NOATFORMAT_DIR, title + '.format.json'), 'utf8'),
            FILE_OP_TIMEOUT_MS, f.name);
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.dueDate)) {
            dueDate = parsed.dueDate;
          }
        } catch (_e) { /* no format file or unreadable: no due date */ }

        notesOut.push({
          name: f.name,
          title: title,
          folder: folder,
          path: f.path,
          created: f.created || 0,
          modified: f.lastModified,
          dueDate: dueDate,
          unavailable: !!f.unavailable
        });
      });

      for (const sub of scan.folders) {
        await walk(sub.path, depth + 1);
      }
    }
    await walk(rootPath, 0);

    // Standalone per-day drawings: .noatformat/calendar/YYYY-MM-DD.png
    const drawings = {};
    try {
      const calDir = path.join(rootPath, NOATFORMAT_DIR, 'calendar');
      const calEntries = await fsp.readdir(calDir, { withFileTypes: true });
      for (const entry of calEntries) {
        if (!entry.isFile()) continue;
        if (!/^\d{4}-\d{2}-\d{2}\.png$/i.test(entry.name)) continue;
        drawings[entry.name.slice(0, 10)] = path.join(calDir, entry.name);
      }
    } catch (_e) { /* no calendar drawings dir: fine */ }

    return { success: true, notes: notesOut, drawings: drawings };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Read a single file
ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const stats = await fsp.stat(filePath);
    if (isDatalessPlaceholder(stats) && isNetworkOffline()) {
      return { success: false, unavailable: true, error: 'File is online-only and not available offline' };
    }
    const content = await withTimeout(fsp.readFile(filePath, 'utf8'), LAZY_READ_TIMEOUT_MS, path.basename(filePath));
    return { success: true, content: content };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Write a text file
ipcMain.handle('write-file', async (event, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    const stats = fs.statSync(filePath);
    return { success: true, lastModified: stats.mtimeMs, size: stats.size };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Delete a file
ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Move a note and all its attachments to a different folder
ipcMain.handle('move-note', async (event, srcFolder, baseName, destFolder) => {
  try {
    const baseLower = baseName.toLowerCase();
    const destSidecarDir = path.join(destFolder, NOATFORMAT_DIR);

    // Plan the moves: the .txt goes to the destination root; every sidecar
    // (canvas/image/audio/format), whether it still sits next to the note
    // (legacy) or already lives in src/.noatformat, lands in dest/.noatformat.
    const moves = []; // { srcPath, destPath, label }
    let foundTxt = false;

    const rootEntries = fs.readdirSync(srcFolder);
    for (const entry of rootEntries) {
      const lower = entry.toLowerCase();
      if (lower === baseLower + '.txt') {
        foundTxt = true;
        moves.push({
          srcPath: path.join(srcFolder, entry),
          destPath: path.join(destFolder, entry),
          label: entry
        });
        continue;
      }
      const info = sidecarInfo(entry);
      if (info && info.baseKey === baseLower) {
        moves.push({
          srcPath: path.join(srcFolder, entry),
          destPath: path.join(destSidecarDir, entry),
          label: NOATFORMAT_DIR + '/' + entry
        });
      }
    }

    if (!foundTxt) {
      return { success: false, error: `No files found for "${baseName}".` };
    }

    const srcSidecarDir = path.join(srcFolder, NOATFORMAT_DIR);
    let sidecarEntries = [];
    try {
      sidecarEntries = fs.readdirSync(srcSidecarDir);
    } catch (_e) { /* no .noatformat in source */ }
    for (const entry of sidecarEntries) {
      const lower = entry.toLowerCase();
      const info = sidecarInfo(entry);
      const isFormat = lower === baseLower + '.format.json';
      if (isFormat || (info && info.baseKey === baseLower)) {
        moves.push({
          srcPath: path.join(srcSidecarDir, entry),
          destPath: path.join(destSidecarDir, entry),
          label: NOATFORMAT_DIR + '/' + entry
        });
      }
    }

    // Collision pre-check. For sidecars also check the destination root, in
    // case the destination folder still holds un-migrated legacy files.
    for (const m of moves) {
      if (fs.existsSync(m.destPath)) {
        return { success: false, error: `A file named "${path.basename(m.destPath)}" already exists in the destination folder.` };
      }
      if (m.destPath.startsWith(destSidecarDir) && fs.existsSync(path.join(destFolder, path.basename(m.destPath)))) {
        return { success: false, error: `A file named "${path.basename(m.destPath)}" already exists in the destination folder.` };
      }
    }

    if (moves.some(m => m.destPath.startsWith(destSidecarDir))) {
      fs.mkdirSync(destSidecarDir, { recursive: true });
    }

    const movedFiles = [];
    for (const m of moves) {
      try {
        fs.renameSync(m.srcPath, m.destPath);
      } catch (renameErr) {
        if (renameErr.code === 'EXDEV') {
          fs.copyFileSync(m.srcPath, m.destPath);
          fs.unlinkSync(m.srcPath);
        } else {
          throw renameErr;
        }
      }
      movedFiles.push(m.label);
    }

    return { success: true, movedFiles: movedFiles };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Check if file exists
ipcMain.handle('file-exists', async (event, filePath) => {
  return fs.existsSync(filePath);
});

ipcMain.handle('file-size', async (event, filePath) => {
  try {
    const stats = await fsp.stat(filePath);
    return { success: true, size: stats.size, unavailable: (isDatalessPlaceholder(stats) && isNetworkOffline()) || undefined };
  } catch (e) {
    return { success: false, size: 0 };
  }
});

// Show file in OS file explorer
ipcMain.handle('show-item-in-folder', async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
      return { success: true };
    }
    return { success: false, error: 'File not found' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Open file with default application
ipcMain.handle('open-path', async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      const result = await shell.openPath(filePath);
      if (result) {
        return { success: false, error: result };
      }
      return { success: true };
    }
    return { success: false, error: 'File not found' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Read image as base64 data URL
ipcMain.handle('read-image-base64', async (event, filePath) => {
  try {
    const stats = await fsp.stat(filePath);
    if (isDatalessPlaceholder(stats) && isNetworkOffline()) {
      return { success: false, unavailable: true, error: 'File is online-only and not available offline' };
    }
    const buffer = await withTimeout(fsp.readFile(filePath), LAZY_READ_TIMEOUT_MS, path.basename(filePath));
    const ext = path.extname(filePath).toLowerCase().slice(1);
    let mimeType = 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
    else if (ext === 'gif') mimeType = 'image/gif';
    else if (ext === 'webp') mimeType = 'image/webp';

    const base64 = buffer.toString('base64');
    return { success: true, dataUrl: `data:${mimeType};base64,${base64}`, fileSize: buffer.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Read an image as a downscaled thumbnail data URL. Decoding + resizing
// happens natively in the main process so the renderer receives tens of KB
// instead of a full-resolution base64 payload (used by the splash grid).
ipcMain.handle('read-image-thumbnail', async (event, filePath, maxWidth = 512) => {
  try {
    const stats = await fsp.stat(filePath);
    if (isDatalessPlaceholder(stats) && isNetworkOffline()) {
      return { success: false, unavailable: true, error: 'File is online-only and not available offline' };
    }
    const buffer = await withTimeout(fsp.readFile(filePath), LAZY_READ_TIMEOUT_MS, path.basename(filePath));
    const img = nativeImage.createFromBuffer(buffer);
    if (!img.isEmpty()) {
      const size = img.getSize();
      const resized = size.width > maxWidth ? img.resize({ width: maxWidth }) : img;
      return { success: true, dataUrl: resized.toDataURL(), fileSize: stats.size };
    }
    // Format nativeImage can't decode (e.g. gif/webp): fall back to the full image.
    const ext = path.extname(filePath).toLowerCase().slice(1);
    let mimeType = 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
    else if (ext === 'gif') mimeType = 'image/gif';
    else if (ext === 'webp') mimeType = 'image/webp';
    return { success: true, dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`, fileSize: stats.size };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Write image from buffer (for drawings)
ipcMain.handle('write-image-buffer', async (event, filePath, base64Data) => {
  try {
    // base64Data can be either:
    // 1. A full data URL like "data:image/jpeg;base64,..."
    // 2. Just the base64 string
    let base64 = base64Data;
    if (base64Data.startsWith('data:')) {
      base64 = base64Data.split(',')[1] || base64Data;
    }
    const buffer = Buffer.from(base64, 'base64');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
    const stats = fs.statSync(filePath);
    return { success: true, lastModified: stats.mtimeMs, size: stats.size };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Copy image from source to destination
ipcMain.handle('copy-image', async (event, srcPath, destPath) => {
  try {
    fs.copyFileSync(srcPath, destPath);
    const stats = fs.statSync(destPath);
    return { success: true, lastModified: stats.mtimeMs, size: stats.size };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Open file picker for images
ipcMain.handle('open-image-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }
    ]
  });
  
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  
  const filePath = result.filePaths[0];
  try {
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().slice(1);
    return {
      path: filePath,
      name: path.basename(filePath),
      ext: ext,
      buffer: buffer.toString('base64')
    };
  } catch (e) {
    return null;
  }
});

// Open file picker for audio
ipcMain.handle('open-audio-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Audio', extensions: ['mp3', 'wav', 'aiff', 'aif', 'ogg', 'm4a', 'flac', 'wma'] }
    ]
  });
  
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  
  const filePath = result.filePaths[0];
  try {
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().slice(1);
    return {
      path: filePath,
      name: path.basename(filePath),
      ext: ext,
      buffer: buffer.toString('base64')
    };
  } catch (e) {
    return null;
  }
});

// Open file picker for GGUF model files
ipcMain.handle('open-model-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'GGUF Models', extensions: ['gguf'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  
  return result.filePaths[0];
});

// Open file picker for the whisper.cpp CLI executable
ipcMain.handle('open-whisper-cli-dialog', async () => {
  const filters = process.platform === 'win32'
    ? [{ name: 'Executables', extensions: ['exe'] }, { name: 'All Files', extensions: ['*'] }]
    : [{ name: 'All Files', extensions: ['*'] }];
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Open file picker for a whisper.cpp ggml model file
ipcMain.handle('open-whisper-model-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'ggml models', extensions: ['bin'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// DeepSeek chat completion (used by auto-fix in the renderer)
ipcMain.handle('deepseek-chat', async (event, opts) => {
  try {
    const o = opts || {};
    if (!o.apiKey) return { success: false, error: 'DeepSeek API key is not set' };
    const text = await callDeepSeek({
      apiKey: o.apiKey,
      system: o.system,
      user: o.user,
      temperature: typeof o.temperature === 'number' ? o.temperature : 0.2,
      maxTokens: typeof o.maxTokens === 'number' ? o.maxTokens : 4096
    });
    return { success: true, text };
  } catch (e) {
    console.error('deepseek-chat error:', e);
    return { success: false, error: String(e.message || e) };
  }
});

// Run local LLM inference
ipcMain.handle('run-local-llm', async (event, modelPath, text) => {
  try {
    console.log('run-local-llm called with modelPath:', modelPath);
    console.log('Text length:', text.length);
    
    if (!modelPath || !fs.existsSync(modelPath)) {
      console.error('Model file not found:', modelPath);
      return { success: false, error: 'Model file not found' };
    }
    
    // Lazy load the llama module using dynamic import (ESM)
    if (!llamaModule) {
      try {
        console.log('Loading node-llama-cpp module...');
        llamaModule = await import('node-llama-cpp');
        console.log('node-llama-cpp loaded successfully');
      } catch (e) {
        console.error('Failed to load node-llama-cpp:', e);
        return { success: false, error: 'Failed to load node-llama-cpp: ' + e.message };
      }
    }
    
    // Load model if not already loaded or if path changed
    if (!currentModel || currentModelPath !== modelPath) {
      console.log('Loading model from:', modelPath);
      try {
        // Dispose old model if exists
        if (currentModel) {
          try {
            if (currentModel.context) {
              console.log('Disposing old context...');
              await currentModel.context.dispose();
            }
            if (currentModel.model) {
              console.log('Disposing old model...');
              await currentModel.model.dispose();
            }
          } catch (e) {
            console.error('Error disposing old model:', e);
          }
          currentModel = null;
        }
        
        // Load new model using v3 API
        console.log('Getting llama instance...');
        const { getLlama, LlamaChatSession } = llamaModule;
        if (!llamaInstance) {
          llamaInstance = await getLlama({ gpu: false });
        }
        console.log('Loading model...');
        const model = await llamaInstance.loadModel({ modelPath });

        currentModel = { model, LlamaChatSession };
        currentModelPath = modelPath;
        console.log('Model loaded successfully');
      } catch (e) {
        console.error('Failed to load model:', e);
        console.error('Error stack:', e.stack);
        currentModel = null;
        currentModelPath = null;
        return { success: false, error: 'Failed to load model: ' + e.message };
      }
    }
    
    // Create a fresh context and session for each inference call
    // This ensures no context pollution from previous calls
    let context = null;
    let session = null;
    
    // Run inference with timeout
    try {
      console.log('Starting inference...');
      console.log('Original text:', text);
      
      // Create fresh context and session
      const contextSize = 2048;
      console.log('Creating fresh context with size:', contextSize);
      context = await currentModel.model.createContext({ contextSize });
      session = new currentModel.LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt: 'You are a spelling and grammar correction assistant. Fix spelling mistakes and grammar errors in the user\'s text. Only fix errors - do not change the meaning, style, or add any commentary. Preserve ALL line breaks, blank lines, and paragraph structure exactly as they appear. Do not merge lines or remove empty lines. Output ONLY the corrected text with no preamble or explanation.'
      });
      console.log('Fresh session created');

      console.log('Calling session.prompt...');

      let timeoutId;
      const timeoutMs = 90000;
      const inferencePromise = session.prompt(text, {
        maxTokens: Math.min(Math.ceil(text.length * 2) + 100, 4096),
        temperature: 0.2,
        topP: 0.9
      });

      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Inference timeout after 90 seconds')), timeoutMs);
      });

      const response = await Promise.race([inferencePromise, timeoutPromise])
        .finally(() => clearTimeout(timeoutId));
      
      // Dispose context immediately after getting response
      try {
        await context.dispose();
        context = null;
      } catch (disposeErr) {
        console.warn('Error disposing context:', disposeErr);
      }
      
      console.log('Inference complete');
      console.log('Raw response:', JSON.stringify(response));
      console.log('Response length:', response.length);
      
      // Strip <think> blocks from reasoning models
      let cleanedResponse = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      
      // Remove common prefixes/suffixes models might add (case insensitive)
      const unwantedPrefixes = [
        'CORRECTED TEXT:',
        'Corrected text:',
        'Here is the corrected text:',
        'Here\'s the corrected text:',
        'The corrected text is:',
        'Corrected:',
        'Here is the text with corrections:',
        'Fixed text:',
        'Fixed:',
        'Output:',
        'Result:',
        'Sure, here',
        'Sure! Here',
        'Of course',
        'I\'ve corrected',
        'I have corrected',
        'The corrected version:',
        'Here you go:'
      ];
      
      for (const prefix of unwantedPrefixes) {
        if (cleanedResponse.toLowerCase().startsWith(prefix.toLowerCase())) {
          cleanedResponse = cleanedResponse.substring(prefix.length).trim();
        }
      }
      
      // If the response contains "INPUT TEXT:" it might have repeated the prompt - extract after CORRECTED TEXT:
      if (cleanedResponse.includes('INPUT TEXT:') || cleanedResponse.includes('CORRECTED TEXT:')) {
        const marker = 'CORRECTED TEXT:';
        const markerIndex = cleanedResponse.lastIndexOf(marker);
        if (markerIndex !== -1) {
          cleanedResponse = cleanedResponse.substring(markerIndex + marker.length).trim();
        }
      }
      
      // Remove wrapping quotes if model added them and original didn't have them
      const originalHasQuotes = (text.startsWith('"') && text.endsWith('"')) || 
                                (text.startsWith("'") && text.endsWith("'"));
      if (!originalHasQuotes) {
        if ((cleanedResponse.startsWith('"') && cleanedResponse.endsWith('"')) ||
            (cleanedResponse.startsWith("'") && cleanedResponse.endsWith("'"))) {
          cleanedResponse = cleanedResponse.slice(1, -1);
        }
      }
      
      // Remove markdown code blocks if model wrapped the response
      if (cleanedResponse.startsWith('```') && cleanedResponse.includes('```', 3)) {
        const firstNewline = cleanedResponse.indexOf('\n');
        const lastBackticks = cleanedResponse.lastIndexOf('```');
        if (firstNewline > 0 && lastBackticks > firstNewline) {
          cleanedResponse = cleanedResponse.substring(firstNewline + 1, lastBackticks).trim();
        }
      }
      
      // Remove trailing commentary that some models add (after periods followed by explanation)
      // Look for patterns like ". I fixed..." or ". Note:" at the end
      const commentaryPatterns = [
        /\.\s*(I (have |had )?(fixed|corrected|changed|made|updated).*$)/i,
        /\.\s*(Note:.*$)/i,
        /\.\s*(I hope.*$)/i,
        /\.\s*(Let me know.*$)/i,
        /\.\s*(The (main |only )?changes? (I made |were|are|is).*$)/i
      ];
      
      for (const pattern of commentaryPatterns) {
        const match = cleanedResponse.match(pattern);
        if (match) {
          // Only trim if the commentary is at the end and the remaining text is reasonable
          const trimmed = cleanedResponse.replace(pattern, '.');
          if (trimmed.length >= text.length * 0.5) {
            cleanedResponse = trimmed;
          }
        }
      }
      
      console.log('Cleaned response:', JSON.stringify(cleanedResponse));
      
      // Validate the response isn't completely different from input
      const originalLength = text.length;
      const responseLength = cleanedResponse.length;
      
      // Only reject if response is drastically different (40% shorter or 150% longer)
      if (responseLength < originalLength * 0.4) {
        console.warn('Response is too short:', responseLength, 'vs', originalLength);
        console.warn('Rejecting response - too much content deleted');
        return { success: false, error: 'Model output too short. Try a different model.' };
      }
      
      if (responseLength > originalLength * 2.5) {
        console.warn('Response is too long:', responseLength, 'vs', originalLength);
        console.warn('Rejecting response - too much content added');
        return { success: false, error: 'Model added too much text. Try a different model.' };
      }
      
      // If response is empty or just whitespace, that's a failure
      if (!cleanedResponse || cleanedResponse.trim().length === 0) {
        console.warn('Response is empty');
        return { success: false, error: 'Model returned empty response.' };
      }
      
      // Check if the response is identical to input (model didn't do anything)
      if (cleanedResponse.trim().toLowerCase() === text.trim().toLowerCase()) {
        console.log('Response identical to input - no changes made by model');
        // Return success but with the original text - the UI will show "no fixes needed"
        return { success: true, text: cleanedResponse };
      }
      
      console.log('Returning corrected text');
      return { success: true, text: cleanedResponse };
    } catch (e) {
      console.error('Inference error:', e);
      console.error('Error stack:', e.stack);
      
      // Clean up the context we created for this call
      try {
        if (context) {
          console.log('Disposing context after error...');
          await context.dispose();
          context = null;
        }
      } catch (cleanupErr) {
        console.error('Error disposing context:', cleanupErr);
      }
      
      // Only dispose the model on critical errors (not timeouts)
      if (e.message && !e.message.includes('timeout')) {
        try {
          console.log('Cleaning up model after critical error...');
          if (currentModel && currentModel.model) {
            await currentModel.model.dispose();
          }
          currentModel = null;
          currentModelPath = null;
          llamaInstance = null;
        } catch (modelCleanupErr) {
          console.error('Error during model cleanup:', modelCleanupErr);
        }
      }
      
      return { success: false, error: 'Inference failed: ' + e.message };
    }
  } catch (e) {
    console.error('run-local-llm error:', e);
    console.error('Error stack:', e.stack);
    return { success: false, error: String(e.message || e) };
  }
});

// ===========================================================================
// Import from IC (Sony IC recorder -> whisper.cpp -> DeepSeek -> notes)
// ===========================================================================

const IC_REC_DIR = 'REC_FILE';
const IC_LEDGER_NAME = 'ic-imports.json';
const IC_WHISPER_TIMEOUT_MS = 30 * 60 * 1000;
// Keep each DeepSeek call's output comfortably inside its token budget:
// ~24k chars of transcript is roughly 6k output tokens.
const IC_DEEPSEEK_CHUNK_CHARS = 24000;
const IC_DEEPSEEK_SINGLE_CALL_MAX_CHARS = 30000;
const IC_DEEPSEEK_MAX_TOKENS = 16384;
const IC_DEEPSEEK_MAX_TOKENS_CAP = 65536;
// An edit only cleans up wording, so it should never come back much shorter
// than the transcript it was given. Shorter than this means it was cut off.
const IC_EDIT_MIN_LENGTH_RATIO = 0.6;
// Whisper must have produced text up to (nearly) the end of the speech.
const IC_WHISPER_MAX_END_GAP_SEC = 30;
const IC_WHISPER_MIN_COVERAGE = 0.9;
let icImportRunning = false;

// Readability rules enforced on every edit (prompt + verification + fallback).
const NOTE_PARA_MAX_WORDS = 120;     // hard limit per paragraph
const NOTE_PARA_TARGET_WORDS = 90;   // where the deterministic splitter aims
const NOTE_WORDS_PER_HEADING = 300;  // at least one bold heading per this many words
const NOTE_MIN_WORDS_FOR_HEADING = 80;

const IC_EDIT_SYSTEM_PROMPT =
  'You are an editor cleaning up a raw voice-memo transcript (or rough note text). Follow these instructions exactly:\n' +
  '1) Format the text into readable paragraphs - fixing grammar, spelling and punctuation and managing the flow of the paragraphs to make it more readable - with bold text for the titles of each subsection. Do not edit the text changing words etc; you are just cleaning up what exists and making it more presentable. Keep everything; do not summarise or drop content.\n' +
  '2) Decide what the title should be based on the contents of the text.\n' +
  'STRUCTURE RULES (mandatory):\n' +
  `- Short paragraphs: aim for 40-${NOTE_PARA_TARGET_WORDS} words each and NEVER more than ${NOTE_PARA_MAX_WORDS} words. Split long stretches at natural sentence boundaries. Separate paragraphs with one blank line.\n` +
  `- Subsection headings: put a short bold heading (2-6 words) before every group of 2-4 paragraphs, whenever the topic shifts. The very first line of the edited text must be a heading. For long texts that means at least one heading per ${NOTE_WORDS_PER_HEADING} words.\n` +
  '- Mark every heading by wrapping it in double asterisks on its own line, e.g. **Subsection Title**. Use no other markdown (no #, no bullets, no code fences, no --- lines).\n' +
  'Respond in plain text using exactly this layout and nothing else:\n' +
  'Title: <short title, max 80 characters, one line>\n' +
  '\n' +
  '<the edited text>';

// Second pass when the first result is under-structured: same text back,
// only allowed to insert headings and paragraph breaks.
const IC_RESTRUCTURE_SYSTEM_PROMPT =
  'You are restructuring an already-edited note for readability. Do NOT change, reorder, add or remove any words or sentences. You may only:\n' +
  `- insert blank lines to split paragraphs so that every paragraph is between 40 and ${NOTE_PARA_TARGET_WORDS} words (hard maximum ${NOTE_PARA_MAX_WORDS}), splitting only between sentences;\n` +
  `- insert short bold subsection headings (2-6 words, on their own line, wrapped in double asterisks like **Heading**) before every group of 2-4 paragraphs, with at least one heading per ${NOTE_WORDS_PER_HEADING} words, and one as the very first line.\n` +
  'Keep existing **headings**. Use no other markdown. Respond with ONLY the restructured text, no title line, no commentary.';

function getIcImportCacheDir() {
  const dir = path.join(app.getPath('userData'), 'ic-import-cache');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_e) {}
  return dir;
}

function isDirSync(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_e) { return false; }
}

function isFileSync(p) {
  try { return fs.statSync(p).isFile(); } catch (_e) { return false; }
}

// Find every mounted IC recorder's REC_FILE directory. First hit wins.
function findIcRecorderRoots() {
  const roots = [];
  const envDir = process.env.NOATBOAT_IC_REC_FILE;
  if (envDir && isDirSync(envDir)) return [envDir];

  const tryAdd = (p) => { if (isDirSync(p)) roots.push(p); };

  if (process.platform === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');
    for (const L of letters) tryAdd(`${L}:\\${IC_REC_DIR}`);
  } else if (process.platform === 'darwin') {
    tryAdd(path.join('/Volumes', 'IC RECORDER', IC_REC_DIR));
    try {
      for (const v of fs.readdirSync('/Volumes')) {
        const p = path.join('/Volumes', v, IC_REC_DIR);
        if (!roots.includes(p)) tryAdd(p);
      }
    } catch (_e) {}
  } else {
    let user = '';
    try { user = os.userInfo().username; } catch (_e) {}
    for (const base of [`/media/${user}`, `/run/media/${user}`, '/media', '/mnt']) {
      try {
        for (const v of fs.readdirSync(base)) tryAdd(path.join(base, v, IC_REC_DIR));
      } catch (_e) {}
    }
  }
  return roots;
}

// List every .mp3 under REC_FILE/FOLDER* sorted oldest first.
function listIcRecordings(recFileDir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(recFileDir, { withFileTypes: true }); } catch (_e) { return out; }
  for (const ent of entries) {
    if (!ent.isDirectory() || !/^FOLDER\d*$/i.test(ent.name)) continue;
    const dir = path.join(recFileDir, ent.name);
    let files = [];
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { continue; }
    for (const f of files) {
      if (!f.isFile() || !/\.mp3$/i.test(f.name)) continue;
      const p = path.join(dir, f.name);
      try {
        const st = fs.statSync(p);
        out.push({ name: f.name, path: p, size: st.size, mtimeMs: st.mtimeMs, folder: ent.name });
      } catch (_e) {}
    }
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out;
}

function icLedgerPath(icNotesFolder) {
  return path.join(icNotesFolder, NOATFORMAT_DIR, IC_LEDGER_NAME);
}

function loadIcLedger(ledgerPath) {
  try {
    if (fs.existsSync(ledgerPath)) {
      const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.imports && typeof parsed.imports === 'object') {
        return { version: 1, imports: parsed.imports };
      }
    }
  } catch (e) {
    console.warn('IC import ledger unreadable, starting fresh:', e.message);
  }
  return { version: 1, imports: {} };
}

function saveIcLedger(ledgerPath, ledger) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const tmp = ledgerPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8');
  fs.renameSync(tmp, ledgerPath);
}

function icImportKey(rec) {
  return `${rec.name}|${rec.size}|${Math.round(rec.mtimeMs)}`;
}

// FAT mtimes are 2s-granular and drift with timezone handling across OSes, so a
// name+size match is also treated as already imported.
function isAlreadyImported(ledger, rec) {
  if (ledger.imports[icImportKey(rec)]) return true;
  const lowerName = rec.name.toLowerCase();
  for (const entry of Object.values(ledger.imports)) {
    if (!entry) continue;
    if (String(entry.sourceName || '').toLowerCase() === lowerName && entry.sourceSize === rec.size) return true;
  }
  return false;
}

// --- Ledger vs. disk -------------------------------------------------------
// The ledger says what was imported; the notes folder says what still exists.
// Notes can be moved into subfolders, so index every .txt under the folder.
function buildNoteIndex(rootDir, maxDepth = 4) {
  const index = new Map(); // lowercased file name -> absolute path
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.') || depth >= maxDepth) continue;
        walk(path.join(dir, ent.name), depth + 1);
      } else if (ent.isFile() && /\.txt$/i.test(ent.name)) {
        const key = ent.name.toLowerCase();
        if (!index.has(key)) index.set(key, path.join(dir, ent.name));
      }
    }
  };
  if (rootDir) walk(rootDir, 0);
  return index;
}

function findNoteUnderFolder(rootDir, noteName, maxDepth = 4, index = null) {
  return (index || buildNoteIndex(rootDir, maxDepth)).get(String(noteName || '').toLowerCase()) || null;
}

// A note named "<recording basename> - YYYY-MM-DD" (optionally " (N)") is the
// fallback used when the edit produced no title, i.e. that import failed.
function isFallbackNoteName(noteName, rec) {
  let base = String(noteName || '')
    .replace(/\.txt$/i, '')
    .replace(/ \(\d+\)$/, '')
    .replace(/ - \d{4}-\d{2}-\d{2}$/, '')
    .replace(/ \(\d+\)$/, '')
    .trim().toLowerCase();
  const expected = sanitizeTitleToFilenameMain(String(rec.name || '').replace(/\.[^.]+$/, '')).toLowerCase();
  return base === expected || base === 'recording';
}

// All ledger entries for a recording (exact key plus name+size matches).
function ledgerEntryFor(ledger, rec) {
  const keys = [];
  const exact = icImportKey(rec);
  if (ledger.imports[exact]) keys.push(exact);
  const lowerName = String(rec.name || '').toLowerCase();
  for (const [k, entry] of Object.entries(ledger.imports)) {
    if (k === exact || !entry) continue;
    if (String(entry.sourceName || '').toLowerCase() === lowerName && entry.sourceSize === rec.size) keys.push(k);
  }
  if (!keys.length) return null;
  let key = keys[0];
  for (const k of keys) {
    if (String(ledger.imports[k].importedAt || '') > String(ledger.imports[key].importedAt || '')) key = k;
  }
  return { key, entry: ledger.imports[key], keys };
}

// fresh: never imported. present: imported and the note still exists.
// failed: imported, note gone, and it was a fallback-named (failed) import.
// deleted: imported with a real title, note since removed by the user.
function classifyRecordings(all, ledger, icNotesFolder) {
  const index = buildNoteIndex(icNotesFolder);
  const out = { fresh: [], present: [], failed: [], deleted: [] };
  for (const rec of all) {
    const m = ledgerEntryFor(ledger, rec);
    if (!m) { out.fresh.push(rec); continue; }
    const anyPresent = m.keys.some(k => { const e = ledger.imports[k]; return e && e.note && index.has(String(e.note).toLowerCase()); });
    if (anyPresent) { out.present.push(rec); continue; }
    const item = { rec, entry: m.entry, key: m.key, keys: m.keys };
    if (isFallbackNoteName(m.entry.note, rec)) out.failed.push(item); else out.deleted.push(item);
  }
  return out;
}

function transcodeForWhisper(mp3Path, wavPath) {
  // whisper.cpp requires 16 kHz mono signed 16-bit PCM WAV.
  return runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', mp3Path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', wavPath]);
}

// ctl (optional) = { signal, onChild }: signal aborts by killing the child,
// onChild reports the spawned process so a Stop can reach it.
function runWhisperCli(cliPath, modelPath, wavPath, outBase, ctl) {
  return new Promise((resolve, reject) => {
    const signal = ctl && ctl.signal;
    if (signal && signal.aborted) { reject(cancelledError()); return; }
    if (!isFileSync(cliPath)) { reject(new Error(`whisper-cli not found: ${cliPath}`)); return; }
    if (!isFileSync(modelPath)) { reject(new Error(`Whisper model not found: ${modelPath}`)); return; }
    // -oj also writes <outBase>.json with per-segment offsets so we can verify
    // the transcript reaches the end of the audio.
    // -mc 0: do not feed the previous segment back in as context. With context
    // on, Whisper falls into repetition loops on long memos and silently
    // replaces minutes of speech with one phrase repeated (measured: ~40%
    // of a 10-minute memo lost). Without it the transcript is complete.
    const args = ['-m', modelPath, '-f', wavPath, '-nt', '-np', '-otxt', '-oj', '-of', outBase, '-l', 'auto', '-mc', '0'];
    let p;
    try {
      p = spawn(cliPath, args, { windowsHide: true, cwd: path.dirname(cliPath) });
    } catch (e) {
      reject(new Error(`Could not start whisper-cli: ${e.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    const onAbort = () => { try { p.kill(); } catch (_e) {} };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (ctl && ctl.onChild) { try { ctl.onChild(p); } catch (_e) {} }
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (ctl && ctl.onChild) { try { ctl.onChild(null); } catch (_e) {} }
    };
    p.stdout.on('data', (d) => { stdout += d.toString(); });
    p.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    p.on('error', (err) => {
      cleanup();
      const hint = err && err.code === 'EACCES' ? ' (not executable - run: chmod +x on the whisper-cli binary)' : '';
      reject(new Error(`whisper-cli failed to start: ${err.message}${hint}`));
    });
    p.on('close', (code) => {
      cleanup();
      if (signal && signal.aborted) { reject(cancelledError()); return; }
      if (code !== 0) {
        reject(new Error((stderr || '').trim().split('\n').slice(-5).join('\n') || `whisper-cli exited with code ${code}`));
        return;
      }
      const txtPath = outBase + '.txt';
      let text = '';
      try {
        if (fs.existsSync(txtPath)) text = fs.readFileSync(txtPath, 'utf8');
      } catch (_e) {}
      if (!text.trim()) text = stdout;
      // Segment offsets (ms) from the JSON output, when the build provides it.
      let lastEndMs = null;
      let segmentCount = null;
      try {
        const jsonPath = outBase + '.json';
        if (fs.existsSync(jsonPath)) {
          const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          const segs = Array.isArray(j.transcription) ? j.transcription : [];
          segmentCount = segs.length;
          for (const s of segs) {
            const to = s && s.offsets && Number(s.offsets.to);
            if (Number.isFinite(to) && (lastEndMs === null || to > lastEndMs)) lastEndMs = to;
          }
        }
      } catch (_e) {}
      resolve({ text, lastEndMs, segmentCount });
    });
  });
}

// Whisper can fall into a loop that repeats one phrase over and over. Collapse
// any sentence/line repeated 3+ times in a row down to a single copy.
function collapseRepetitions(text) {
  const units = String(text || '').split(/(?<=[.!?])\s+|\n+/).map(u => u.trim()).filter(Boolean);
  const out = [];
  let i = 0;
  while (i < units.length) {
    const norm = units[i].toLowerCase();
    let j = i;
    while (j < units.length && units[j].toLowerCase() === norm) j++;
    const count = j - i;
    if (count >= 3) out.push(units[i]);           // a loop: keep one copy
    else for (let k = i; k < j; k++) out.push(units[k]); // 1-2 copies may be genuine
    i = j;
  }
  return out.join(' ');
}

// Seconds of audio in a 16 kHz mono 16-bit WAV.
function wavDurationSec(wavPath) {
  try { return Math.max(0, (fs.statSync(wavPath).size - 44) / 32000); } catch (_e) { return 0; }
}

// Where speech effectively ends: the start of an unterminated trailing
// silence (recorder left running), else the full duration.
function detectSpeechEndSec(wavPath, durationSec) {
  return new Promise((resolve) => {
    if (!ffmpegPath) { resolve(durationSec); return; }
    const p = spawn(ffmpegPath, ['-hide_banner', '-nostats', '-i', wavPath, '-af', 'silencedetect=noise=-35dB:d=3', '-f', 'null', '-'], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 200000) err = err.slice(-200000); });
    p.on('error', () => resolve(durationSec));
    p.on('close', () => {
      let lastStart = null;
      let lastEnd = null;
      for (const m of err.matchAll(/silence_(start|end): *([\d.]+)/g)) {
        const v = parseFloat(m[2]);
        if (m[1] === 'start') lastStart = v; else lastEnd = v;
      }
      if (lastStart !== null && (lastEnd === null || lastEnd < lastStart)) resolve(Math.max(0, lastStart));
      else resolve(durationSec);
    });
  });
}

function stripCodeFences(s) {
  let t = String(s || '').trim();
  const m = t.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/);
  if (m) t = m[1].trim();
  return t;
}

function cleanTitle(t) {
  return String(t || '').replace(/[*_#`"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// Decode a JSON-ish string value that may contain raw (unescaped) newlines.
function decodeLooseJsonString(s) {
  return s.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (_m, c) => {
    switch (c[0]) {
      case '"': return '"'; case '\\': return '\\'; case '/': return '/';
      case 'b': return '\b'; case 'f': return '\f'; case 'n': return '\n';
      case 'r': return '\r'; case 't': return '\t';
      default: return String.fromCharCode(parseInt(c.slice(1), 16));
    }
  });
}

// Parse a DeepSeek editing reply into { title, body }.
// Preferred layout is "Title: ...\n\n<body>"; legacy JSON replies (possibly
// with raw newlines inside the strings) are also understood.
function parseDeepSeekNote(raw, fallbackTitle) {
  const cleaned = stripCodeFences(raw).replace(/\r\n?/g, '\n');
  const trimmed = cleaned.trim();

  // 1) Legacy / accidental JSON
  if (trimmed.startsWith('{')) {
    const last = trimmed.lastIndexOf('}');
    const jsonText = last > 0 ? trimmed.slice(0, last + 1) : trimmed;
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && typeof parsed.body === 'string' && parsed.body.trim()) {
        return { title: cleanTitle(parsed.title) || fallbackTitle, body: parsed.body };
      }
    } catch (_e) {}
    const tm = jsonText.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const bm = jsonText.match(/"body"\s*:\s*"([\s\S]*?)"\s*}?\s*$/);
    if (bm && bm[1].trim()) {
      return { title: cleanTitle(tm ? decodeLooseJsonString(tm[1]) : '') || fallbackTitle, body: decodeLooseJsonString(bm[1]) };
    }
  }

  // 2) "Title: ..." first line
  const lines = trimmed.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const tm = i < lines.length ? lines[i].match(/^\s*[*_#\s]*title[*_\s]*:\s*(.+?)\s*$/i) : null;
  if (tm) {
    const body = lines.slice(i + 1).join('\n').trim();
    if (body) return { title: cleanTitle(tm[1]) || fallbackTitle, body };
  }

  // 3) Fallback: whole reply is the body; title from its first line
  const firstLine = lines.map(l => cleanTitle(l)).find(l => l.length > 0) || '';
  return { title: (firstLine.startsWith('{') ? '' : firstLine) || fallbackTitle, body: trimmed || String(raw || '') };
}

function splitTranscriptIntoChunks(transcript, maxChars) {
  const paras = transcript.split(/\n\s*\n/);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if (cur && (cur.length + p.length + 2) > maxChars) { chunks.push(cur); cur = ''; }
    if (p.length > maxChars) {
      if (cur) { chunks.push(cur); cur = ''; }
      for (let i = 0; i < p.length; i += maxChars) chunks.push(p.slice(i, i + maxChars));
      continue;
    }
    cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [transcript];
}

// Length sanity check: strip formatting markers before comparing so bold
// markup and paragraph breaks do not skew the ratio.
function editedLengthRatio(edited, source) {
  const norm = (s) => String(s || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().length;
  const src = norm(source);
  return src === 0 ? 1 : norm(edited) / src;
}

// opts (optional) = { signal, onPhase }: signal cancels, onPhase reports
// sub-steps ("attempt 2 (larger budget)") so slow runs look alive.
async function editTranscriptWithDeepSeek(apiKey, transcript, fallbackTitle, opts) {
  const signal = (opts && opts.signal) || null;
  const onPhase = (opts && opts.onPhase) || null;
  const callOne = async (text, partLabel) => {
    let maxTokens = IC_DEEPSEEK_MAX_TOKENS;
    let lastErr = null;
    let why = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      throwIfAborted(signal);
      if (onPhase) onPhase('edit', 'Editing with DeepSeek' + (partLabel || '') + (attempt ? ` · attempt ${attempt + 1}${why}` : ''));
      let raw;
      try {
        raw = await callDeepSeek({
          apiKey,
          system: IC_EDIT_SYSTEM_PROMPT,
          user: text,
          temperature: 0.3,
          maxTokens,
          timeoutMs: 10 * 60 * 1000,
          signal
        });
      } catch (e) {
        if (isCancelled(e)) throw e;
        if (e && e.code === 'DEEPSEEK_TRUNCATED' && maxTokens < IC_DEEPSEEK_MAX_TOKENS_CAP) {
          console.warn(`DeepSeek reply truncated at ${maxTokens} tokens; retrying with a larger budget`);
          maxTokens = Math.min(maxTokens * 2, IC_DEEPSEEK_MAX_TOKENS_CAP);
          lastErr = e;
          why = ' (larger budget)';
          continue;
        }
        throw e;
      }
      const parsed = parseDeepSeekNote(raw, fallbackTitle);
      const ratio = editedLengthRatio(parsed.body, text);
      if (ratio >= IC_EDIT_MIN_LENGTH_RATIO) return parsed;
      lastErr = new Error(`DeepSeek edit looks cut off (${Math.round(ratio * 100)}% of the transcript length)`);
      why = ' (reply looked cut off)';
      console.warn(lastErr.message + (attempt < 2 ? '; retrying' : ''));
    }
    throw lastErr || new Error('DeepSeek edit failed');
  };
  if (transcript.length <= IC_DEEPSEEK_SINGLE_CALL_MAX_CHARS) return callOne(transcript, '');

  const chunks = splitTranscriptIntoChunks(transcript, IC_DEEPSEEK_CHUNK_CHARS);
  let title = '';
  const bodies = [];
  for (let i = 0; i < chunks.length; i++) {
    throwIfAborted(signal);
    const r = await callOne(chunks[i], ` · part ${i + 1}/${chunks.length}`);
    if (i === 0) title = r.title;
    bodies.push(r.body.trim());
  }
  return { title: title || fallbackTitle, body: bodies.join('\n\n') };
}

// Convert **bold** markers into plain text plus Noat Boat bold spans
// (character offsets into the returned text).
function markdownBoldToSpans(text) {
  let src = String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
  // Markdown headings ("## Title") become bold lines too.
  src = src.replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, (_m, t) => /^\*\*.*\*\*$/.test(t.trim()) ? t.trim() : `**${t.trim()}**`);
  const re = /\*\*([^*\n][^*\n]*?)\*\*/g;
  let out = '';
  let last = 0;
  const spans = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out += src.slice(last, m.index);
    const start = out.length;
    out += m[1];
    spans.push({ start, end: out.length, type: 'bold' });
    last = m.index + m[0].length;
  }
  out += src.slice(last);
  // Stray markers: strip them and shift the spans that follow each removal.
  let idx;
  while ((idx = out.indexOf('**')) !== -1) {
    out = out.slice(0, idx) + out.slice(idx + 2);
    for (const sp of spans) {
      if (sp.start > idx) sp.start -= 2;
      if (sp.end > idx) sp.end -= 2;
    }
  }
  return { text: out, spans: spans.filter(sp => sp.end > sp.start) };
}

// One whisper-cli at a time, app-wide: note jobs and IC import share this
// queue so N requests never mean N CPU-bound whisper processes.
let whisperChain = Promise.resolve();
function runWhisperQueued(fn) {
  const run = whisperChain.then(fn, fn);   // run even if the previous job failed
  whisperChain = run.catch(() => {});      // never poison the chain
  return run;
}

// DeepSeek calls may overlap, but not without limit.
const acquireDeepSeek = makeSemaphore(3);

// Convert one audio file to text with ffmpeg + whisper-cli, waiting for the
// whisper queue first.
async function transcribeAudioToText(audioPath, whisperCliPath, whisperModelPath, onPhase, ctl) {
  if (onPhase) onPhase('queued', 'Waiting for Whisper');
  return runWhisperQueued(() => {
    // A stopped run that was waiting its turn never spawns whisper.
    throwIfAborted(ctl && ctl.signal);
    return transcribeAudioToTextNow(audioPath, whisperCliPath, whisperModelPath, onPhase, ctl);
  });
}

// The actual ffmpeg + whisper-cli run. Temp files live in the ic-import cache
// under unique hashed names and are always removed.
async function transcribeAudioToTextNow(audioPath, whisperCliPath, whisperModelPath, onPhase, ctl) {
  const signal = ctl && ctl.signal;
  throwIfAborted(signal);
  if (!ffmpegPath) throw new Error('ffmpeg is not available; cannot convert audio');
  if (!isFileSync(audioPath)) throw new Error(`Audio file not found: ${audioPath}`);
  const cacheDir = getIcImportCacheDir();
  const sig = getFileSignature(audioPath);
  const hash = crypto.createHash('sha1').update(`${audioPath}|${sig}|${Date.now()}`).digest('hex');
  const wavPath = path.join(cacheDir, `${hash}.wav`);
  const outBase = path.join(cacheDir, hash);
  try {
    if (onPhase) onPhase('transcode', 'Converting audio');
    await transcodeForWhisper(audioPath, wavPath);
    throwIfAborted(signal);
    const durationSec = wavDurationSec(wavPath);
    const speechEndSec = await detectSpeechEndSec(wavPath, durationSec);
    throwIfAborted(signal);

    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      throwIfAborted(signal);
      if (onPhase) onPhase('transcribe', attempt === 0 ? 'Transcribing with Whisper' : 'Re-transcribing with Whisper');
      const r = await withTimeout(runWhisperCli(whisperCliPath, whisperModelPath, wavPath, outBase, ctl), IC_WHISPER_TIMEOUT_MS, 'Whisper transcription');
      throwIfAborted(signal);
      const text = String((r && r.text) || '').trim();
      if (!text) { lastErr = new Error('Empty transcript'); continue; }

      // Completeness: the last segment must reach (nearly) the end of speech.
      if (r.lastEndMs !== null && speechEndSec > 0) {
        const lastEndSec = r.lastEndMs / 1000;
        const gap = speechEndSec - lastEndSec;
        const coverage = lastEndSec / speechEndSec;
        if (gap > IC_WHISPER_MAX_END_GAP_SEC && coverage < IC_WHISPER_MIN_COVERAGE) {
          lastErr = new Error(`Transcription incomplete: Whisper stopped at ${Math.round(lastEndSec)}s of ${Math.round(speechEndSec)}s of speech`);
          console.warn(lastErr.message + (attempt === 0 ? '; retrying' : ''));
          continue;
        }
      } else if (r.lastEndMs === null) {
        console.warn('whisper-cli produced no JSON segment data; skipping completeness check');
      }
      return collapseRepetitions(text);
    }
    throw lastErr || new Error('Transcription failed');
  } finally {
    try { fs.unlinkSync(wavPath); } catch (_e) {}
    try { fs.unlinkSync(outBase + '.txt'); } catch (_e) {}
    try { fs.unlinkSync(outBase + '.json'); } catch (_e) {}
  }
}

// --- Structure verification on the markdown body (before span conversion) ---
const MD_HEADING_LINE_RE = /^\s*\*\*[^*\n]+\*\*\s*$/;

function countWords(s) {
  const t = String(s || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

function noteStructureStats(md) {
  const paras = String(md || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  let headings = 0;
  let maxParaWords = 0;
  let words = 0;
  for (const p of paras) {
    const lines = p.split('\n');
    const bodyLines = [];
    for (const l of lines) {
      if (MD_HEADING_LINE_RE.test(l)) headings++; else bodyLines.push(l);
    }
    const w = countWords(bodyLines.join(' ').replace(/\*\*/g, ''));
    words += w;
    if (w > maxParaWords) maxParaWords = w;
  }
  return { words, paras: paras.length, headings, maxParaWords };
}

function expectedHeadings(words) {
  if (words < NOTE_MIN_WORDS_FOR_HEADING) return 0;
  return Math.max(1, Math.floor(words / NOTE_WORDS_PER_HEADING));
}

function structureOk(stats) {
  return stats.maxParaWords <= NOTE_PARA_MAX_WORDS && stats.headings >= expectedHeadings(stats.words);
}

// Deterministic fallback: split any paragraph over the limit at sentence
// boundaries into chunks of about NOTE_PARA_TARGET_WORDS words.
function splitLongParagraphsMd(md) {
  const paras = String(md || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  const out = [];
  for (const para of paras) {
    const p = para.trim();
    if (!p) continue;
    if (countWords(p) <= NOTE_PARA_MAX_WORDS || /\n/.test(p) && p.split('\n').some(l => MD_HEADING_LINE_RE.test(l)) && countWords(p) <= NOTE_PARA_MAX_WORDS + 6) { out.push(p); continue; }
    // Keep a leading heading line attached to the first chunk.
    const lines = p.split('\n');
    let heading = '';
    let text = p;
    if (MD_HEADING_LINE_RE.test(lines[0])) { heading = lines[0].trim(); text = lines.slice(1).join(' ').trim(); }
    else text = lines.join(' ').trim();
    const sentences = text.split(/(?<=[.!?…]["')\]]?)\s+/).filter(Boolean);
    const chunks = [];
    let cur = [];
    let curWords = 0;
    for (const s of sentences) {
      const w = countWords(s);
      if (cur.length && curWords + w > NOTE_PARA_TARGET_WORDS) { chunks.push(cur.join(' ')); cur = []; curWords = 0; }
      cur.push(s);
      curWords += w;
    }
    if (cur.length) chunks.push(cur.join(' '));
    if (heading) chunks[0] = heading + '\n' + chunks[0];
    out.push(...chunks);
  }
  return out.join('\n\n');
}

// Old-tool style "--- Title ---" heading lines become bold headings.
function normaliseDashHeadings(md) {
  return String(md || '').replace(/^[ \t]*-{3,}[ \t]*(.+?)[ \t]*-{3,}[ \t]*$/gm, (_m, t) => `**${t.trim()}**`);
}

async function restructureWithDeepSeek(apiKey, body, opts) {
  const raw = await callDeepSeek({
    apiKey,
    system: IC_RESTRUCTURE_SYSTEM_PROMPT,
    user: body,
    temperature: 0.2,
    maxTokens: IC_DEEPSEEK_MAX_TOKENS,
    timeoutMs: 10 * 60 * 1000,
    signal: (opts && opts.signal) || null
  });
  let out = stripCodeFences(raw).replace(/\r\n?/g, '\n').trim();
  out = out.replace(/^\s*[*_#\s]*title[*_\s]*:.*\n+/i, ''); // tolerate a stray title line
  const ratio = editedLengthRatio(out, body);
  if (ratio < 0.85 || ratio > 1.2) throw new Error(`Restructure pass changed the text length (${Math.round(ratio * 100)}%)`);
  return out;
}

// Shared "edit + bold" step used by IC import, Transcribe Audio and Format Text.
// Guarantees the structure rules: verified after the edit, one restructure pass
// if needed, then a deterministic paragraph split as the last resort.
async function editTextToNote(apiKey, rawText, fallbackTitle, opts) {
  const signal = (opts && opts.signal) || null;
  const onPhase = (opts && opts.onPhase) || null;
  const release = await acquireDeepSeek();
  try {
    throwIfAborted(signal); // cancelled while waiting for a DeepSeek slot
    const source = normaliseDashHeadings(rawText);
    const edited = await editTranscriptWithDeepSeek(apiKey, source, fallbackTitle, { signal, onPhase });
    const title = edited.title;
    let body = normaliseDashHeadings(edited.body);
    let stats = noteStructureStats(body);
    for (let pass = 0; pass < 2 && !structureOk(stats); pass++) {
      throwIfAborted(signal);
      console.warn(`Edit under-structured (max para ${stats.maxParaWords} words, ${stats.headings} headings for ${stats.words} words); restructuring (pass ${pass + 1})`);
      if (onPhase) onPhase('edit', `Restructuring with DeepSeek · pass ${pass + 1}/2`);
      try {
        const restructured = await restructureWithDeepSeek(apiKey, body, { signal });
        const s2 = noteStructureStats(restructured);
        // Accept the pass if it improved either measure without breaking the other.
        if (s2.headings >= stats.headings && s2.maxParaWords <= Math.max(stats.maxParaWords, NOTE_PARA_MAX_WORDS)) { body = restructured; stats = s2; }
      } catch (e) {
        if (isCancelled(e)) throw e; // never fall through to the splitter on a Stop
        console.warn('Restructure pass failed:', e.message);
      }
    }
    throwIfAborted(signal);
    if (stats.maxParaWords > NOTE_PARA_MAX_WORDS) {
      if (onPhase) onPhase('edit', 'Splitting long paragraphs');
      body = splitLongParagraphsMd(body);
      stats = noteStructureStats(body);
    }
    if (stats.headings < expectedHeadings(stats.words)) {
      console.warn(`Note still has ${stats.headings} heading(s) for ${stats.words} words after restructuring`);
    }
    const { text, spans } = markdownBoldToSpans(body);
    if (!text.trim()) throw new Error('DeepSeek returned an empty note');
    return { title, text, spans };
  } finally {
    release();
  }
}

// Mirrors sanitizeTitleToFilename in the renderer so both agree on names.
function sanitizeTitleToFilenameMain(title) {
  let t = (title || '').trim();
  if (t.toLowerCase().endsWith('.txt')) t = t.slice(0, -4);
  t = t.replace(/[\\\/:*?"<>|]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > 120) t = t.slice(0, 120).trim();
  return t;
}

function uniqueNoteName(dir, title) {
  let existing = new Set();
  try { existing = new Set(fs.readdirSync(dir).map(n => n.toLowerCase())); } catch (_e) {}
  let name = `${title}.txt`;
  let i = 1;
  while (existing.has(name.toLowerCase())) name = `${title} (${i++}).txt`;
  return name;
}

function ymdLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Sony recorders name files YYMMDD_HHMM.mp3; prefer that over the FAT mtime.
function recordedDateFor(rec) {
  const m = rec.name.match(/^(\d{2})(\d{2})(\d{2})_\d{4}/);
  if (m) {
    const mm = parseInt(m[2], 10), dd = parseInt(m[3], 10);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return `20${m[1]}-${m[2]}-${m[3]}`;
  }
  return ymdLocal(rec.mtimeMs);
}

// Read-only look at the recorder vs. the ledger: what is new, what failed
// before and will be retried, and what the user deleted (offered for re-import).
ipcMain.handle('ic-import-scan', async (event, opts) => {
  const o = opts || {};
  try {
    if (!o.icNotesFolder) return { success: false, error: 'Transcribed notes folder is not set' };
    const recFileDir = o.recFileDir || findIcRecorderRoots()[0];
    if (!recFileDir || !isDirSync(recFileDir)) {
      return { success: false, noDevice: true, error: 'No IC RECORDER found - plug it in and try again' };
    }
    const all = listIcRecordings(recFileDir);
    const ledger = loadIcLedger(icLedgerPath(o.icNotesFolder));
    const c = classifyRecordings(all, ledger, o.icNotesFolder);
    return {
      success: true,
      recFileDir,
      counts: { total: all.length, fresh: c.fresh.length, failed: c.failed.length, deleted: c.deleted.length, present: c.present.length },
      failed: c.failed.map(f => f.rec.name),
      deleted: c.deleted.map(d => ({
        name: d.rec.name,
        size: d.rec.size,
        folder: d.rec.folder,
        recordedAt: recordedDateFor(d.rec),
        note: d.entry.note,
        importedAt: d.entry.importedAt
      }))
    };
  } catch (e) {
    console.error('ic-import-scan error:', e);
    return { success: false, error: String((e && e.message) || e) };
  }
});

// Stop the active import: no more recordings start, the in-flight DeepSeek
// request is aborted and the in-flight whisper-cli is killed. The recording
// being processed writes nothing, so the next import picks it up again.
let icImportCancel = null; // { requested, controller, whisperChild } for the active run

ipcMain.handle('ic-import-cancel', async () => {
  const c = icImportCancel;
  if (!c) return { success: true, running: false };
  c.requested = true;
  try { c.controller.abort(); } catch (_e) {}
  if (c.whisperChild) { try { c.whisperChild.kill(); } catch (_e) {} }
  return { success: true, running: icImportRunning };
});

ipcMain.handle('ic-import-run', async (event, opts) => {
  const o = opts || {};
  if (icImportRunning) return { success: false, error: 'An import is already running' };

  if (!o.deepseekKey) return { success: false, error: 'DeepSeek API key is not set' };
  if (!o.whisperCliPath || !isFileSync(o.whisperCliPath)) return { success: false, error: `whisper-cli not found: ${o.whisperCliPath || '(not set)'}` };
  if (!o.whisperModelPath || !isFileSync(o.whisperModelPath)) return { success: false, error: `Whisper model not found: ${o.whisperModelPath || '(not set)'}` };
  if (!o.icNotesFolder) return { success: false, error: 'Transcribed notes folder is not set' };
  if (!ffmpegPath) return { success: false, error: 'ffmpeg is not available; cannot convert recordings' };

  const send = (p) => { try { event.sender.send('ic-import-progress', p); } catch (_e) {} };

  const recFileDir = o.recFileDir || findIcRecorderRoots()[0];
  if (!recFileDir || !isDirSync(recFileDir)) {
    return { success: false, noDevice: true, error: 'No IC RECORDER found - plug it in and try again' };
  }

  icImportRunning = true;
  const cancel = { requested: false, controller: new AbortController(), whisperChild: null };
  icImportCancel = cancel;
  const ctl = { signal: cancel.controller.signal, onChild: (p) => { cancel.whisperChild = p; } };
  const imported = [];
  const errors = [];
  let skipped = 0;
  let retried = 0;
  let reimported = 0;
  try {
    send({ phase: 'scan', message: 'Scanning recorder...' });
    const all = listIcRecordings(recFileDir);

    const sidecarDir = path.join(o.icNotesFolder, NOATFORMAT_DIR);
    fs.mkdirSync(sidecarDir, { recursive: true });
    const ledgerPath = icLedgerPath(o.icNotesFolder);
    const ledger = loadIcLedger(ledgerPath);

    // New recordings and earlier failed imports always run; notes the user
    // deleted only run when explicitly ticked (reimportNames).
    const c = classifyRecordings(all, ledger, o.icNotesFolder);
    const reimportSet = new Set((Array.isArray(o.reimportNames) ? o.reimportNames : []).map(n => String(n).toLowerCase()));
    const chosen = c.deleted.filter(d => reimportSet.has(d.rec.name.toLowerCase()));
    const staleKeys = new Map(); // recording name (lowercased) -> ledger keys to replace
    const origin = new Map();    // recording name (lowercased) -> 'failed' | 'deleted'
    for (const f of c.failed) { staleKeys.set(f.rec.name.toLowerCase(), f.keys); origin.set(f.rec.name.toLowerCase(), 'failed'); }
    for (const d of chosen) { staleKeys.set(d.rec.name.toLowerCase(), d.keys); origin.set(d.rec.name.toLowerCase(), 'deleted'); }
    const todo = (o.reimportOnly ? chosen.map(d => d.rec) : [...c.fresh, ...c.failed.map(f => f.rec), ...chosen.map(d => d.rec)])
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    skipped = all.length - todo.length;
    const total = todo.length;
    send({ phase: 'scan', message: `Found ${all.length} recording(s): ${o.reimportOnly ? 0 : c.fresh.length} new, ${o.reimportOnly ? 0 : c.failed.length} to retry, ${chosen.length} re-import, ${skipped} already imported`, total, current: 0 });

    for (let i = 0; i < todo.length; i++) {
      if (cancel.requested) break;
      const rec = todo[i];
      const current = i + 1;
      const onPhase = (phase, message) => send({ phase, current, total, file: rec.name, message });
      try {
        const transcript = await transcribeAudioToText(rec.path, o.whisperCliPath, o.whisperModelPath, onPhase, ctl);

        send({ phase: 'edit', current, total, file: rec.name, message: 'Editing with DeepSeek' });
        const fallbackTitle = rec.name.replace(/\.mp3$/i, '');
        const { title, text, spans } = await editTextToNote(o.deepseekKey, transcript, fallbackTitle, { signal: ctl.signal, onPhase });
        if (cancel.requested) throw cancelledError(); // stopped after the edit: write nothing

        send({ phase: 'write', current, total, file: rec.name, message: 'Saving note' });
        const recordedAt = recordedDateFor(rec);
        const base = sanitizeTitleToFilenameMain(title) || 'Recording';
        const noteName = uniqueNoteName(o.icNotesFolder, `${base} - ${recordedAt}`);
        const noteBase = noteName.slice(0, -4);

        fs.writeFileSync(path.join(o.icNotesFolder, noteName), text, 'utf8');
        const icSource = { name: rec.name, size: rec.size, mtime: rec.mtimeMs, recordedAt, folder: rec.folder };
        fs.writeFileSync(path.join(sidecarDir, `${noteBase}.format.json`), JSON.stringify({ spans, icSource }), 'utf8');
        fs.copyFileSync(rec.path, path.join(sidecarDir, `${noteBase}.mp3`));

        // Replace any stale entry for this recording (failed or deleted import).
        for (const k of staleKeys.get(rec.name.toLowerCase()) || []) delete ledger.imports[k];
        ledger.imports[icImportKey(rec)] = {
          note: noteName,
          importedAt: new Date().toISOString(),
          sourceName: rec.name,
          sourceSize: rec.size,
          sourceMtime: rec.mtimeMs,
          sourceFolder: rec.folder
        };
        saveIcLedger(ledgerPath, ledger);

        const from = origin.get(rec.name.toLowerCase());
        if (from === 'failed') retried++; else if (from === 'deleted') reimported++;
        imported.push({ note: noteName, source: rec.name });
        send({ phase: 'done-file', current, total, file: rec.name, note: noteName, message: 'Imported' });
      } catch (e) {
        if (isCancelled(e) || cancel.requested) {
          send({ phase: 'cancelled', current, total, file: rec.name, message: 'Stopped' });
          break;
        }
        const msg = String((e && e.message) || e);
        console.error('IC import failed for', rec.name, msg);
        errors.push({ file: rec.name, error: msg });
        send({ phase: 'error', current, total, file: rec.name, message: msg });
      }
    }
    return { success: true, imported, skipped, errors, recFileDir, retried, reimported, cancelled: cancel.requested };
  } catch (e) {
    console.error('ic-import-run error:', e);
    return { success: false, imported, skipped, errors, recFileDir, retried, reimported, cancelled: cancel.requested, error: String((e && e.message) || e) };
  } finally {
    icImportRunning = false;
    icImportCancel = null;
  }
});

// ---------------------------------------------------------------------------
// Per-note AI jobs (Transcribe Audio / Format Text). Any number of notes may
// have a job at once (one per note). Jobs run in the background; whisper runs
// are serialised through runWhisperQueued and DeepSeek through acquireDeepSeek.
// Progress and completion go out on 'note-ai-progress' as
//   { jobId, notePath, noteName, kind, phase, message, result?, error? }
// with phase in queued | transcode | transcribe | edit | done | error.
// The main process never writes note files on its own; the renderer decides
// (conflict prompts live there) and calls 'note-ai-write-result'.
const noteAiJobs = new Map(); // jobId -> job
let noteAiSeq = 0;

function noteKeyOf(p) {
  const r = path.resolve(String(p || ''));
  return (process.platform === 'win32' || process.platform === 'darwin') ? r.toLowerCase() : r;
}

function activeNoteAiJobFor(notePath) {
  const k = noteKeyOf(notePath);
  for (const j of noteAiJobs.values()) if (j.noteKey === k) return j;
  return null;
}

function noteAiPublic(j) {
  return { jobId: j.jobId, kind: j.kind, notePath: j.notePath, noteName: j.noteName, phase: j.phase, message: j.message, startedText: j.startedText, startedAt: j.startedAt };
}

async function runNoteAiJob(job, o) {
  const send = (phase, message, extra) => {
    job.phase = phase;
    job.message = message;
    const payload = { jobId: job.jobId, notePath: job.notePath, noteName: job.noteName, kind: job.kind, phase, message, ...(extra || {}) };
    let wc = null;
    try {
      if (job.sender && !job.sender.isDestroyed()) wc = job.sender;
      else if (mainWindow && !mainWindow.isDestroyed()) wc = mainWindow.webContents;
    } catch (_e) {}
    try { if (wc) wc.send('note-ai-progress', payload); } catch (_e) {}
  };
  try {
    let raw;
    let transcript = null;
    let fallbackTitle;
    if (job.kind === 'transcribe') {
      transcript = await transcribeAudioToText(o.audioPath, o.whisperCliPath, o.whisperModelPath, send);
      raw = transcript;
      fallbackTitle = path.basename(o.audioPath).replace(/\.[^.]+$/, '');
    } else {
      raw = String(o.text || '').trim();
      fallbackTitle = o.fallbackTitle || 'Note';
    }
    send('edit', job.kind === 'transcribe' ? 'Editing with DeepSeek' : 'Formatting with DeepSeek');
    const { title, text, spans } = await editTextToNote(o.deepseekKey, raw, fallbackTitle);
    send('done', 'Done', { result: { title, text, spans, transcript } });
  } catch (e) {
    console.error('note-ai job failed:', job.kind, job.notePath, e);
    send('error', 'Failed', { error: String((e && e.message) || e) });
  } finally {
    noteAiJobs.delete(job.jobId);
  }
}

ipcMain.handle('note-ai-start', async (event, opts) => {
  const o = opts || {};
  if (o.kind !== 'transcribe' && o.kind !== 'format') return { success: false, error: 'Unknown AI action' };
  if (!o.notePath) return { success: false, error: 'No note path given' };
  if (!o.deepseekKey) return { success: false, error: 'DeepSeek API key is not set' };
  if (o.kind === 'transcribe') {
    if (!o.audioPath) return { success: false, error: 'This note has no audio attached' };
    if (!o.whisperCliPath || !isFileSync(o.whisperCliPath)) return { success: false, error: `whisper-cli not found: ${o.whisperCliPath || '(not set)'}` };
    if (!o.whisperModelPath || !isFileSync(o.whisperModelPath)) return { success: false, error: `Whisper model not found: ${o.whisperModelPath || '(not set)'}` };
    if (!ffmpegPath) return { success: false, error: 'ffmpeg is not available; cannot convert audio' };
  } else if (!String(o.text || '').trim()) {
    return { success: false, error: 'The note is empty' };
  }
  if (activeNoteAiJobFor(o.notePath)) return { success: false, error: 'An AI action is already running for this note' };

  const job = {
    jobId: 'nai-' + (++noteAiSeq),
    noteKey: noteKeyOf(o.notePath),
    kind: o.kind,
    notePath: o.notePath,
    noteName: o.noteName || path.basename(o.notePath),
    startedText: o.kind === 'format' ? String(o.text || '') : (typeof o.startedText === 'string' ? o.startedText : null),
    phase: 'queued',
    message: 'Queued',
    startedAt: Date.now(),
    sender: event.sender
  };
  noteAiJobs.set(job.jobId, job);
  runNoteAiJob(job, o); // not awaited: runs in the background
  return { success: true, jobId: job.jobId };
});

ipcMain.handle('note-ai-list', async () => {
  return { success: true, jobs: [...noteAiJobs.values()].map(noteAiPublic) };
});

// Write an AI result to disk: the .txt plus the .format.json sidecar with the
// new bold spans merged over whatever else the sidecar holds (dueDate, icSource).
// With expectText set, refuses (conflict) when the file on disk differs from it.
ipcMain.handle('note-ai-write-result', async (event, opts) => {
  const o = opts || {};
  try {
    if (!o.notePath) return { success: false, error: 'No note path given' };
    let diskText = null;
    try { diskText = fs.readFileSync(o.notePath, 'utf8'); } catch (_e) {}
    if (!o.force && typeof o.expectText === 'string' && (diskText === null ? '' : diskText) !== o.expectText) {
      return { success: false, conflict: true, missing: diskText === null };
    }
    fs.mkdirSync(path.dirname(o.notePath), { recursive: true });
    fs.writeFileSync(o.notePath, String(o.text || ''), 'utf8');
    const st = fs.statSync(o.notePath);

    const base = path.basename(o.notePath).replace(/\.txt$/i, '');
    const fmtPath = path.join(path.dirname(o.notePath), NOATFORMAT_DIR, base + '.format.json');
    let existing = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(fmtPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
    } catch (_e) {}
    const payload = { ...existing, spans: Array.isArray(o.spans) ? o.spans : [] };
    // Same rule as the renderer's saveFormatSpans: no spans and nothing else -> no sidecar.
    if (payload.spans.length === 0 && !payload.dueDate && !payload.icSource) {
      try { fs.unlinkSync(fmtPath); } catch (_e) {}
    } else {
      fs.mkdirSync(path.dirname(fmtPath), { recursive: true });
      fs.writeFileSync(fmtPath, JSON.stringify(payload), 'utf8');
    }
    return { success: true, lastModified: st.mtimeMs, size: st.size };
  } catch (e) {
    console.error('note-ai-write-result error:', e);
    return { success: false, error: String((e && e.message) || e) };
  }
});

// Read audio as base64 data URL
ipcMain.handle('read-audio-base64', async (event, filePath) => {
  try {
    const stats = await fsp.stat(filePath);
    if (isDatalessPlaceholder(stats) && isNetworkOffline()) {
      return { success: false, unavailable: true, error: 'File is online-only and not available offline' };
    }
    const buffer = await withTimeout(fsp.readFile(filePath), LAZY_READ_TIMEOUT_MS, path.basename(filePath));
    const ext = path.extname(filePath).toLowerCase().slice(1);
    let mimeType = 'audio/mpeg';
    if (ext === 'wav') mimeType = 'audio/wav';
    else if (ext === 'aiff' || ext === 'aif') mimeType = 'audio/x-aiff'; // x-aiff is more widely supported
    else if (ext === 'ogg') mimeType = 'audio/ogg';
    else if (ext === 'm4a') mimeType = 'audio/mp4';
    else if (ext === 'flac') mimeType = 'audio/flac';
    else if (ext === 'wma') mimeType = 'audio/x-ms-wma';
    
    const base64 = buffer.toString('base64');
    return { success: true, dataUrl: `data:${mimeType};base64,${base64}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Write audio from buffer
ipcMain.handle('write-audio-buffer', async (event, filePath, base64Data) => {
  try {
    const base64 = base64Data.replace(/^data:audio\/[^;]+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
    const stats = fs.statSync(filePath);
    return { success: true, lastModified: stats.mtimeMs, size: stats.size };
  } catch (e) {
    return { success: false, error: e.message };
  }
});


// Get a playback URL for an audio file.
// If the format isn't reliably supported by Chromium (e.g. AIFF), it will be transcoded to WAV via ffmpeg.
ipcMain.handle('get-audio-playback-url', async (event, filePath, options = {}) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: 'Audio file not found' };
    }

    const stats = await fsp.stat(filePath);
    if (isDatalessPlaceholder(stats) && isNetworkOffline()) {
      return { success: false, unavailable: true, error: 'Audio is online-only and not available offline' };
    }

    const ext = path.extname(filePath).toLowerCase().slice(1);
    const forceTranscode = !!options.forceTranscode;

    // Keep these as-is to avoid unnecessary transcoding.
    const passthrough = new Set(['mp3', 'wav', 'ogg']);
    const needsTranscode = forceTranscode || !passthrough.has(ext);

    if (!needsTranscode) {
      return { success: true, url: pathToFileURL(filePath).href, wasTranscoded: false };
    }

    if (!ffmpegPath) {
      // No ffmpeg available; return the original file URL and let the renderer try.
      return { success: true, url: pathToFileURL(filePath).href, wasTranscoded: false, warning: 'ffmpeg unavailable' };
    }

    const wavPath = await transcodeToWavCached(filePath);
    return { success: true, url: pathToFileURL(wavPath).href, wasTranscoded: true, transcodedPath: wavPath };
  } catch (e) {
    return { success: false, error: String(e.message || e) };
  }
});

// Transcode an audio file to MP3 and return a data: URL (used for HTML/GitHub export).
ipcMain.handle('transcode-audio-to-mp3-dataurl', async (event, filePath, bitrateKbps = 128) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: 'Audio file not found' };
    }
    if (!ffmpegPath) {
      return { success: false, error: 'ffmpeg unavailable' };
    }
    const out = await transcodeToMp3DataUrl(filePath, bitrateKbps);
    return { success: true, dataUrl: out.dataUrl };
  } catch (e) {
    return { success: false, error: String(e.message || e) };
  }
});

// Note: Audio MP3 compression is handled in the renderer process using vendored lamejs (lame.min.js)
// See compressAudioToMp3() function in index.html

// Read canvas JSON
ipcMain.handle('read-canvas-json', async (event, filePath) => {
  try {
    let stats;
    try {
      stats = await fsp.stat(filePath);
    } catch (_e) {
      return { success: true, data: null };
    }
    if (isDatalessPlaceholder(stats) && isNetworkOffline()) {
      return { success: false, unavailable: true, error: 'Canvas is online-only and not available offline' };
    }
    const content = await withTimeout(fsp.readFile(filePath, 'utf8'), LAZY_READ_TIMEOUT_MS, path.basename(filePath));
    return { success: true, data: content };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Write canvas JSON
ipcMain.handle('write-canvas-json', async (event, filePath, jsonData) => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, jsonData, 'utf8');
    const stats = fs.statSync(filePath);
    return { success: true, lastModified: stats.mtimeMs };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Delete canvas files. Sweeps both the .noatformat home and the legacy
// next-to-note location so un-migrated files are cleaned up too.
ipcMain.handle('delete-canvas-files', async (event, basePath) => {
  try {
    const dir = path.dirname(basePath);
    const base = path.basename(basePath);
    const candidates = [];
    for (const suffix of ['.canvas.json', '.canvas.png']) {
      candidates.push(path.join(dir, base + suffix));
      candidates.push(path.join(dir, NOATFORMAT_DIR, base + suffix));
    }
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (_e) { /* keep sweeping the rest */ }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Show input dialog (for new note name)
ipcMain.handle('show-prompt', async (event, message, defaultValue) => {
  // Electron doesn't have a native prompt, so we use a custom approach
  // We'll create a small input dialog window
  return new Promise((resolve) => {
    const promptWindow = new BrowserWindow({
      width: 400,
      height: 160,
      parent: mainWindow,
      modal: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'prompt-preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    promptWindow.setMenuBarVisibility(false);
    
    // Load a simple HTML for the prompt
    promptWindow.loadFile('prompt.html');
    
    promptWindow.once('ready-to-show', () => {
      promptWindow.show();
      promptWindow.webContents.send('set-prompt', message, defaultValue || '');
    });

    // Handle the response
    ipcMain.once('prompt-response', (e, result) => {
      promptWindow.close();
      resolve(result);
    });

    promptWindow.on('closed', () => {
      resolve(null);
    });
  });
});

// Show confirm dialog
ipcMain.handle('show-confirm', async (event, message) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0,
    title: 'Confirm Delete',
    message: message
  });
  return result.response === 1;
});

// Show alert
ipcMain.handle('show-alert', async (event, message) => {
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['OK'],
    title: 'Alert',
    message: message
  });
  return true;
});

// Create a new folder
ipcMain.handle('create-folder', async (event, folderPath) => {
  try {
    if (fs.existsSync(folderPath)) {
      return { success: false, error: 'Folder already exists' };
    }
    fs.mkdirSync(folderPath, { recursive: true });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Show save dialog
ipcMain.handle('show-save-dialog', async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title || 'Save File',
    defaultPath: options.defaultPath,
    filters: options.filters || []
  });
  
  if (result.canceled) {
    return null;
  }
  
  return result.filePath;
});


// ============ Export Handlers ============

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Export to PDF using Electron's printToPDF
// Export to PDF using Electron's printToPDF
ipcMain.handle('export-pdf', async (event, savePath, notesData, isDark) => {
  let tempPath = null;
  let pdfWindow = null;
  
  try {
    // Helper function to convert image to JPEG at 75% quality
    function convertToJpeg(dataUrl) {
      try {
        // Create native image from data URL
        const img = nativeImage.createFromDataURL(dataUrl);
        if (img.isEmpty()) return null;
        
        // Convert to JPEG at 75% quality
        const jpegBuffer = img.toJPEG(75);
        const base64 = jpegBuffer.toString('base64');
        return `data:image/jpeg;base64,${base64}`;
      } catch (e) {
        console.error('Failed to convert image to JPEG:', e);
        return null;
      }
    }
    
    // Convert all images to JPEG for smaller file size
    const optimizedNotesData = notesData.map(note => {
      if (note.imageDataUrl && note.imageDataUrl.startsWith('data:image/')) {
        const converted = convertToJpeg(note.imageDataUrl);
        if (converted) {
          return { ...note, imageDataUrl: converted };
        }
      }
      return note;
    });
    
    // Create a hidden window for rendering
    pdfWindow = new BrowserWindow({
      width: 794,  // A4 at 96 DPI
      height: 1123,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false // Important for background rendering
      }
    });
    
    // Generate HTML content for all notes
    const bgColor = isDark ? '#1a1a1a' : '#ffffff';
    const textColor = isDark ? '#e0e0e0' : '#111111';
    const mutedColor = isDark ? '#999999' : '#666666';
    const borderColor = isDark ? '#3a3a3a' : '#d9d9d9';
    const contentBg = isDark ? '#252525' : '#f5f5f5';
    
    let pagesHtml = '';
    
    for (let i = 0; i < optimizedNotesData.length; i++) {
      const note = optimizedNotesData[i];
      const dateStr = note.lastModified ? new Date(note.lastModified).toLocaleString() : '';
      
      // Text page
      pagesHtml += `
        <div class="page">
          <h1>${escapeHtml(note.title)}</h1>
          <div class="meta">${escapeHtml(dateStr)}</div>
          <div class="content">${escapeHtml(note.content || '(empty)')}</div>
        </div>
      `;
      
      // Image page if exists
      if (note.imageDataUrl) {
        pagesHtml += `
          <div class="page image-page">
            <img src="${note.imageDataUrl}" />
          </div>
        `;
      }
    }
    
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    @page { size: A4; margin: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: ${bgColor};
      color: ${textColor};
    }
    .page {
      width: 210mm;
      min-height: 297mm;
      padding: 20mm;
      page-break-after: always;
      background: ${bgColor};
    }
    .page:last-child { page-break-after: auto; }
    h1 {
      font-size: 24px;
      font-family: ui-monospace, monospace;
      margin-bottom: 8px;
    }
    .meta {
      font-size: 11px;
      color: ${mutedColor};
      font-family: ui-monospace, monospace;
      margin-bottom: 20px;
    }
    .content {
      font-size: 12px;
      font-family: ui-monospace, monospace;
      white-space: pre-wrap;
      line-height: 1.6;
      background: ${contentBg};
      padding: 15px;
      border-radius: 8px;
      border: 1px solid ${borderColor};
    }
    .image-page {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .image-page img {
      max-width: 100%;
      max-height: 257mm;
      object-fit: contain;
      border-radius: 8px;
    }
  </style>
</head>
<body>${pagesHtml}</body>
</html>`;
    
    // Write HTML to temp file to avoid URL length limits
    tempPath = path.join(os.tmpdir(), `noatboat-pdf-${Date.now()}.html`);
    fs.writeFileSync(tempPath, html);
    
    await pdfWindow.loadFile(tempPath);
    
    // Wait for images to load using a small buffer
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const pdfData = await pdfWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });
    
    fs.writeFileSync(savePath, pdfData);
    
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    if (pdfWindow) pdfWindow.close();
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch(e) {}
    }
  }
});

// Export to PNG using Electron's capturePage
ipcMain.handle('export-png', async (event, filePath, noteData, isDark) => {
  let tempPath = null;
  let pngWindow = null;

  try {
    const WIDTH = 1800;
    const HEIGHT = 1000;

    // Create a hidden window for rendering
    pngWindow = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false, // Vital for offscreen painting
        offscreen: true // Encourages rendering even when hidden
      }
    });

    const bgColor = isDark ? '#1a1a1a' : '#f2f2f2';
    const panelColor = isDark ? '#252525' : '#ffffff';
    const textColor = isDark ? '#e0e0e0' : '#111111';
    const mutedColor = isDark ? '#999999' : '#666666';
    const borderColor = isDark ? '#3a3a3a' : '#d9d9d9';
    const contentBg = isDark ? '#1e1e1e' : '#ffffff';
    const gridMinor = isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)';
    const gridMajor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

    const dateStr = noteData.lastModified ? new Date(noteData.lastModified).toLocaleString() : '';

    const imageHtml = noteData.imageDataUrl
      ? '<img src="' + noteData.imageDataUrl + '" />'
      : '<div class="placeholder">(no image)</div>';

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: ${bgColor};
      color: ${textColor};
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      padding: 36px;
    }
    .panel {
      background: ${panelColor};
      border: 1px solid ${borderColor};
      border-radius: 16px;
      padding: 28px;
      height: 100%;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .header h1 {
      font-size: 28px;
      font-family: ui-monospace, monospace;
      margin-bottom: 6px;
      word-break: break-word;
    }
    .meta {
      font-size: 13px;
      color: ${mutedColor};
      font-family: ui-monospace, monospace;
    }
    .split {
      flex: 1;
      min-height: 0;
      display: flex;
      gap: 18px;
    }
    .col {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .colTitle {
      font-size: 12px;
      color: ${mutedColor};
      font-family: ui-monospace, monospace;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .box {
      flex: 1;
      min-height: 0;
      border: 1px solid ${borderColor};
      border-radius: 12px;
      background: ${contentBg};
      overflow: hidden;
      position: relative;
    }
    .textBox {
      padding: 16px 18px;
      height: 100%;
      overflow: auto;
      font-size: 14px;
      font-family: ui-monospace, monospace;
      white-space: pre-wrap;
      line-height: 1.55;
      background:
        linear-gradient(${gridMinor} 1px, transparent 1px),
        linear-gradient(90deg, ${gridMinor} 1px, transparent 1px),
        linear-gradient(${gridMajor} 1px, transparent 1px),
        linear-gradient(90deg, ${gridMajor} 1px, transparent 1px);
      background-size: 24px 24px, 24px 24px, 120px 120px, 120px 120px;
      background-position: 0 0, 0 0, 0 0, 0 0;
    }
    .textBox::-webkit-scrollbar { width: 0; height: 0; }
    .imageBox {
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12px;
      background: ${contentBg};
    }
    .imageBox img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      border-radius: 10px;
      border: 1px solid ${borderColor};
    }
    .placeholder {
      font-size: 13px;
      color: ${mutedColor};
      font-family: ui-monospace, monospace;
      text-align: center;
      padding: 20px;
    }
  </style>
</head>
<body>
  <div class="panel">
    <div class="header">
      <h1>${escapeHtml(noteData.title)}</h1>
      <div class="meta">${escapeHtml(dateStr)}</div>
    </div>

    <div class="split">
      <div class="col">
        <div class="colTitle">Text</div>
        <div class="box">
          <div class="textBox">${escapeHtml(noteData.content || '(empty)')}</div>
        </div>
      </div>

      <div class="col">
        <div class="colTitle">Canvas / Image</div>
        <div class="box">
          <div class="imageBox">${imageHtml}</div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

    // Write HTML to temp file
    tempPath = path.join(os.tmpdir(), `noatboat-png-${Date.now()}.html`);
    fs.writeFileSync(tempPath, html);

    await pngWindow.loadFile(tempPath);

    // Wait for images to load
    await new Promise(resolve => setTimeout(resolve, 800));

    const image = await pngWindow.webContents.capturePage();
    fs.writeFileSync(filePath, image.toPNG());

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    if (pngWindow) pngWindow.close();
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch(e) {}
    }
  }
});

// Export to EPUB3 using built-in zlib (no external deps)
ipcMain.handle('export-epub', async (event, savePath, bookTitle, notesData, isDark) => {
  try {
    const zlib = require('zlib');
    
    // Helper function to convert image to JPEG at 75% quality
    function convertToJpeg(dataUrl) {
      try {
        // Create native image from data URL
        const img = nativeImage.createFromDataURL(dataUrl);
        if (img.isEmpty()) return null;
        
        // Convert to JPEG at 75% quality
        const jpegBuffer = img.toJPEG(75);
        const base64 = jpegBuffer.toString('base64');
        return `data:image/jpeg;base64,${base64}`;
      } catch (e) {
        console.error('Failed to convert image to JPEG:', e);
        return null;
      }
    }
    
    // Simple ZIP file creator using raw buffers
    const files = [];
    
    // Helper to add file to zip
    function addFile(name, content, compress = true) {
      const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
      files.push({ name, data, compress });
    }
    
    // EPUB structure
    addFile('mimetype', 'application/epub+zip', false);
    
    // META-INF/container.xml
    addFile('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);
    
    // Generate unique ID
    const bookId = 'noatboat-' + Date.now();
    
    // Build manifest and spine items
    const manifestItems = [];
    const spineItems = [];
    
    // CSS
    const bgColor = isDark ? '#1a1a1a' : '#ffffff';
    const textColor = isDark ? '#e0e0e0' : '#111111';
    const mutedColor = isDark ? '#999999' : '#666666';
    const contentBg = isDark ? '#252525' : '#f5f5f5';
    
    const cssContent = `
body {
  font-family: Georgia, serif;
  margin: 1em;
  background: ${bgColor};
  color: ${textColor};
}
h1 { font-size: 1.5em; margin-bottom: 0.5em; }
.meta { font-size: 0.85em; color: ${mutedColor}; margin-bottom: 1em; }
.content {
  font-family: "Courier New", monospace;
  white-space: pre-wrap;
  line-height: 1.6;
  padding: 1em;
  background: ${contentBg};
  border-radius: 8px;
}
.note-image { max-width: 100%; margin: 1em 0; border-radius: 8px; }
.title-page {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  height: 90vh;
  text-align: center;
}
.title-page h1 {
  font-size: 3em;
  margin: 0;
  border: none;
}
`;
    
    addFile('OEBPS/styles.css', cssContent);
    manifestItems.push('<item id="css" href="styles.css" media-type="text/css"/>');

    // --- Add Title Page (Folder Name) ---
    const titlePageId = 'titlepage';
    const titlePageFile = 'titlepage.xhtml';
    const titleContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${escapeHtml(bookTitle)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body class="title-page">
  <h1>${escapeHtml(bookTitle)}</h1>
</body>
</html>`;

    addFile(`OEBPS/${titlePageFile}`, titleContent);
    manifestItems.push(`<item id="${titlePageId}" href="${titlePageFile}" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="${titlePageId}"/>`);
    
    // Generate chapter files
    for (let i = 0; i < notesData.length; i++) {
      const note = notesData[i];
      const chapterId = `chapter${i}`;
      const chapterFile = `${chapterId}.xhtml`;
      
      let imageTag = '';
      
      // Handle image - convert to JPEG for smaller file size
      if (note.imageDataUrl) {
        let imageDataToUse = note.imageDataUrl;
        
        // Convert to JPEG if it's an image
        if (imageDataToUse.startsWith('data:image/')) {
          const converted = convertToJpeg(imageDataToUse);
          if (converted) {
            imageDataToUse = converted;
          }
        }
        
        const match = imageDataToUse.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          const imgFileName = `img${i}.jpg`;
          const imgBuffer = Buffer.from(match[2], 'base64');
          addFile(`OEBPS/images/${imgFileName}`, imgBuffer);
          
          manifestItems.push(`<item id="img${i}" href="images/${imgFileName}" media-type="image/jpeg"/>`);
          imageTag = `<p><img class="note-image" src="images/${imgFileName}" alt="${escapeHtml(note.title)}"/></p>`;
        }
      }
      
      // Note: Audio is not included in EPUB export as most e-readers don't support it
      
      const dateStr = note.lastModified ? new Date(note.lastModified).toLocaleString() : '';
      
      const chapterContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${escapeHtml(note.title)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <h1>${escapeHtml(note.title)}</h1>
  <p class="meta">${escapeHtml(dateStr)}</p>
  <div class="content">${escapeHtml(note.content || '(empty)')}</div>
  ${imageTag}
</body>
</html>`;
      
      addFile(`OEBPS/${chapterFile}`, chapterContent);
      manifestItems.push(`<item id="${chapterId}" href="${chapterFile}" media-type="application/xhtml+xml"/>`);
      spineItems.push(`<itemref idref="${chapterId}"/>`);
    }
    
    // Navigation document
    let navItems = `<li><a href="${titlePageFile}">Title Page</a></li>\n`;
    for (let i = 0; i < notesData.length; i++) {
      navItems += `<li><a href="chapter${i}.xhtml">${escapeHtml(notesData[i].title)}</a></li>\n`;
    }
    
    const navContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Table of Contents</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <nav epub:type="toc">
    <h1>Table of Contents</h1>
    <ol>${navItems}</ol>
  </nav>
</body>
</html>`;
    
    addFile('OEBPS/nav.xhtml', navContent);
    manifestItems.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
    
    // content.opf
    const opfContent = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">${bookId}</dc:identifier>
    <dc:title>${escapeHtml(bookTitle)}</dc:title>
    <dc:creator>Noat Boat</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().split('.')[0]}Z</meta>
  </metadata>
  <manifest>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine>
    ${spineItems.join('\n    ')}
  </spine>
</package>`;
    
    addFile('OEBPS/content.opf', opfContent);
    
    // Create ZIP file manually
    const zipBuffer = createZipBuffer(files);
    fs.writeFileSync(savePath, zipBuffer);
    
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Simple ZIP file creator (no external dependencies)
function createZipBuffer(files) {
  const zlib = require('zlib');
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;
  
  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, 'utf8');
    const data = file.data;
    const compressed = file.compress ? zlib.deflateRawSync(data) : data;
    const useCompression = file.compress && compressed.length < data.length;
    const finalData = useCompression ? compressed : data;
    
    // CRC32
    const crc = crc32(data);
    
    // Local file header
    const localHeader = Buffer.alloc(30 + nameBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(useCompression ? 8 : 0, 8); // compression
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(crc, 14); // crc32
    localHeader.writeUInt32LE(finalData.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuffer.length, 26); // name length
    localHeader.writeUInt16LE(0, 28); // extra length
    nameBuffer.copy(localHeader, 30);
    
    localHeaders.push({ header: localHeader, data: finalData, offset });
    
    // Central directory header
    const centralHeader = Buffer.alloc(46 + nameBuffer.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(useCompression ? 8 : 0, 10); // compression
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0, 14); // mod date
    centralHeader.writeUInt32LE(crc, 16); // crc32
    centralHeader.writeUInt32LE(finalData.length, 20); // compressed size
    centralHeader.writeUInt32LE(data.length, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBuffer.length, 28); // name length
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attr
    centralHeader.writeUInt32LE(0, 38); // external attr
    centralHeader.writeUInt32LE(offset, 42); // local header offset
    nameBuffer.copy(centralHeader, 46);
    
    centralHeaders.push(centralHeader);
    
    offset += localHeader.length + finalData.length;
  }
  
  // Build final buffer
  const centralOffset = offset;
  let centralSize = 0;
  for (const ch of centralHeaders) {
    centralSize += ch.length;
  }
  
  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(files.length, 8); // entries on disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralSize, 12); // central dir size
  eocd.writeUInt32LE(centralOffset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length
  
  // Concatenate all parts
  const parts = [];
  for (const lh of localHeaders) {
    parts.push(lh.header);
    parts.push(lh.data);
  }
  for (const ch of centralHeaders) {
    parts.push(ch);
  }
  parts.push(eocd);
  
  return Buffer.concat(parts);
}

// CRC32 calculation
function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  const table = getCrc32Table();
  
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xFF];
  }
  
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

let crc32Table = null;
function getCrc32Table() {
  if (crc32Table) return crc32Table;
  
  crc32Table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crc32Table[i] = c;
  }
  
  return crc32Table;
}

// Export to HTML
ipcMain.handle('export-html', async (event, saveDir, bookTitle, notesData, assets, isDark) => {
  try {
    // Helper function to convert image to JPEG at 75% quality
    function convertToJpeg(dataUrl) {
      try {
        // Create native image from data URL
        const img = nativeImage.createFromDataURL(dataUrl);
        if (img.isEmpty()) return null;
        
        // Convert to JPEG at 75% quality
        const jpegBuffer = img.toJPEG(75);
        const base64 = jpegBuffer.toString('base64');
        return `data:image/jpeg;base64,${base64}`;
      } catch (e) {
        console.error('Failed to convert image to JPEG:', e);
        return null;
      }
    }
    
    // Create assets folder
    const assetsDir = path.join(saveDir, 'assets');
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
    }
    
    // Map to track renamed assets (oldName -> newName)
    const assetNameMap = {};
    
    // Write assets (convert images to JPEG)
    for (const asset of assets) {
      let dataUrlToWrite = asset.dataUrl;
      let nameToWrite = asset.name;
      
      // Check if this is an image (not audio)
      if (asset.dataUrl.startsWith('data:image/')) {
        const convertedDataUrl = convertToJpeg(asset.dataUrl);
        if (convertedDataUrl) {
          dataUrlToWrite = convertedDataUrl;
          // Change extension to .jpg
          nameToWrite = asset.name.replace(/\.(png|jpg|jpeg|gif|webp)$/i, '.jpg');
          assetNameMap[asset.name] = nameToWrite;
        }
      }
      
      const match = dataUrlToWrite.match(/^data:[^;]+;base64,(.+)$/);
      if (match) {
        const buffer = Buffer.from(match[1], 'base64');
        fs.writeFileSync(path.join(assetsDir, nameToWrite), buffer);
      }
    }
    
    // Generate notes JSON for the app (use mapped names)
    const notesJson = notesData.map(n => ({
      id: n.id,
      title: n.title,
      name: n.name,
      content: n.content,
      lastModified: n.lastModified,
      canvasJson: n.canvasJson || null,
      canvasImage: n.canvasImage ? `assets/${assetNameMap[n.canvasImage] || n.canvasImage}` : null,
      image: n.image ? `assets/${assetNameMap[n.image] || n.image}` : null,
      audio: n.audio ? `assets/${n.audio}` : null
    }));
    
    // CSS styles
    const cssContent = generateExportCss(isDark);
    
    // JavaScript for the app
    const jsContent = generateExportJs();
    
    // Main HTML
    const htmlContent = generateExportHtml(bookTitle, notesJson, cssContent, jsContent, isDark);
    
    fs.writeFileSync(path.join(saveDir, 'index.html'), htmlContent);
    
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

function generateExportCss(isDark) {
  const bgColor = isDark ? '#1a1a1a' : '#f2f2f2';
  const panelColor = isDark ? '#252525' : '#ffffff';
  const textColor = isDark ? '#e0e0e0' : '#111';
  const mutedColor = isDark ? '#999' : '#666';
  const borderColor = isDark ? '#3a3a3a' : '#d9d9d9';
  const hoverBg = isDark ? '#2d2d2d' : '#fafafa';
  const activeBg = isDark ? '#1e3a5f' : '#eef5ff';
  const activeBorder = isDark ? '#2d5a8a' : '#c9dcff';
  const editorBg = isDark ? '#1e1e1e' : '#fff';
  
  return `
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      background-color: ${bgColor};
      background-image:
        repeating-linear-gradient(0deg, ${isDark ? 'rgba(255,255,255,.03)' : 'rgba(0,0,0,.025)'} 0, ${isDark ? 'rgba(255,255,255,.03)' : 'rgba(0,0,0,.025)'} 1px, transparent 1px, transparent 24px),
        repeating-linear-gradient(90deg, ${isDark ? 'rgba(255,255,255,.03)' : 'rgba(0,0,0,.025)'} 0, ${isDark ? 'rgba(255,255,255,.03)' : 'rgba(0,0,0,.025)'} 1px, transparent 1px, transparent 24px),
        repeating-linear-gradient(0deg, ${isDark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.04)'} 0, ${isDark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.04)'} 1px, transparent 1px, transparent 120px),
        repeating-linear-gradient(90deg, ${isDark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.04)'} 0, ${isDark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.04)'} 1px, transparent 1px, transparent 120px);
      color: ${textColor};
      height: 100vh;
      overflow: hidden;
    }
    /* ADDED: General image scaling rule */
    img {
      max-width: 100%;
      height: auto;
      display: block;
    }
    .topbar {
      display: flex;
      gap: 10px;
      align-items: center;
      padding: 10px;
      border-bottom: 1px solid ${borderColor};
      background: linear-gradient(${isDark ? '#2a2a2a' : '#f7f7f7'}, ${isDark ? '#222' : '#efefef'});
    }
    .btn {
      appearance: none;
      border: 1px solid ${borderColor};
      background: ${isDark ? '#333' : '#fff'};
      padding: 7px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      color: ${textColor};
    }
    .btn:hover { background: ${hoverBg}; }
    .search {
      flex: 1;
      min-width: 180px;
      max-width: 400px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid ${borderColor};
      font-size: 14px;
      background: ${isDark ? '#333' : '#fff'};
      color: ${textColor};
      outline: none;
    }
    .main {
      display: grid;
      grid-template-columns: 320px 1fr;
      height: calc(100vh - 52px);
    }
    .left {
      border-right: 1px solid ${borderColor};
      background: ${panelColor};
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .list {
      overflow: auto;
      padding: 6px;
      flex: 1;
    }
    .noteItem {
      border: 1px solid transparent;
      border-radius: 8px;
      padding: 8px 10px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .noteItem:hover {
      background: ${hoverBg};
      border-color: ${borderColor};
    }
    .noteItem.active {
      background: ${activeBg};
      border-color: ${activeBorder};
    }
    .noteTitle {
      font-size: 13px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .noteMeta {
      font-size: 11px;
      color: ${mutedColor};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: ui-monospace, monospace;
    }
    .right {
      background: ${panelColor};
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .editorHeader {
      padding: 10px 12px;
      border-bottom: 1px solid ${borderColor};
      display: flex;
      align-items: baseline;
      gap: 10px;
    }
    .currentTitle {
      font-size: 14px;
      font-weight: 700;
      font-family: ui-monospace, monospace;
      flex: 1;
    }
    .saveState {
      font-size: 12px;
      color: ${mutedColor};
      font-family: ui-monospace, monospace;
    }
    .empty {
      padding: 20px;
      color: ${mutedColor};
      font-size: 14px;
    }
    .editorWrap {
      position: relative;
      flex: 1;
      overflow: hidden;
      display: flex;
      align-items: stretch;
      gap: 18px;
      padding: 12px 14px;
      min-height: 0;
    }
    textarea {
      border: 0;
      resize: none;
      padding: 14px 16px;
      outline: none;
      font-size: 14px;
      line-height: 1.55;
      font-family: ui-monospace, monospace;
      flex: 1 1 50%;
      min-width: 200px;
      max-width: 50%;
      background-color: ${editorBg};
      color: ${textColor};
      border-radius: 8px;
      background-image:
        repeating-linear-gradient(0deg, ${isDark ? 'rgba(255,255,255,.03)' : 'rgba(0,0,0,.025)'} 0, ${isDark ? 'rgba(255,255,255,.03)' : 'rgba(0,0,0,.025)'} 1px, transparent 1px, transparent 24px),
        repeating-linear-gradient(90deg, ${isDark ? 'rgba(255,255,255,.03)' : 'rgba(0,0,0,.025)'} 0, ${isDark ? 'rgba(255,255,255,.03)' : 'rgba(0,0,0,.025)'} 1px, transparent 1px, transparent 24px),
        repeating-linear-gradient(0deg, ${isDark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.04)'} 0, ${isDark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.04)'} 1px, transparent 1px, transparent 120px),
        repeating-linear-gradient(90deg, ${isDark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.04)'} 0, ${isDark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.04)'} 1px, transparent 1px, transparent 120px);
      background-attachment: local;
    }
    .canvasWrap {
      flex: 1 1 50%;
      min-width: 200px;
      border: 1px solid ${borderColor};
      border-radius: 18px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      background: ${editorBg};
    }
    .canvasToolbar {
      display: flex;
      gap: 6px;
      padding: 8px 10px;
      border-bottom: 1px solid ${borderColor};
      background: linear-gradient(${isDark ? '#2a2a2a' : '#f7f7f7'}, ${isDark ? '#222' : '#efefef'});
    }
    .canvasToolbar .btn { padding: 5px 8px; font-size: 12px; }
    .canvasToolbar .btn.active { background: ${activeBg}; border-color: ${activeBorder}; }
    .canvasContainer {
      flex: 1;
      position: relative;
      overflow: hidden;
      background-color: ${editorBg};
      min-height: 0;
      background-image:
        repeating-linear-gradient(0deg, ${isDark ? 'rgba(255,255,255,.02)' : 'rgba(0,0,0,.02)'} 0, ${isDark ? 'rgba(255,255,255,.02)' : 'rgba(0,0,0,.02)'} 1px, transparent 1px, transparent 24px),
        repeating-linear-gradient(90deg, ${isDark ? 'rgba(255,255,255,.02)' : 'rgba(0,0,0,.02)'} 0, ${isDark ? 'rgba(255,255,255,.02)' : 'rgba(0,0,0,.02)'} 1px, transparent 1px, transparent 24px),
        repeating-linear-gradient(0deg, ${isDark ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.035)'} 0, ${isDark ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.035)'} 1px, transparent 1px, transparent 120px),
        repeating-linear-gradient(90deg, ${isDark ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.035)'} 0, ${isDark ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.035)'} 1px, transparent 1px, transparent 120px);
    }
    .canvasContainer canvas { display: block; }
    /* FIXED: Removed aggressive !important rules that caused aspect ratio distortion */
    .canvasContainer .canvas-container { 
      position: absolute !important;
      /* width and height removed to let Fabric.js handle scaling */
    }
    .audioPlayer {
      padding: 10px;
      border-top: 1px solid ${borderColor};
    }
    .audioPlayer audio { width: 100%; }
    @media (max-width: 820px) {
      .main { grid-template-columns: 1fr; }
      .left { height: 40vh; border-right: 0; border-bottom: 1px solid ${borderColor}; }
    }
  `;
}

function generateExportJs() {
  return `
    let notes = window.NOTES_DATA || [];
    let currentIndex = null;
    let fabricCanvas = null;
    let dirty = false;
    
    function fmtDate(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      return d.toLocaleString(undefined, {year:'2-digit', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
    }
    
    function renderList(filter) {
      const list = document.getElementById('list');
      list.innerHTML = '';
      
      const q = (filter || '').toLowerCase();
      const filtered = notes
        .map((n, idx) => ({n, idx}))
        .filter(({n}) => {
          if (!q) return true;
          return n.title.toLowerCase().includes(q) || (n.content || '').toLowerCase().includes(q);
        })
        .sort((a,b) => (b.n.lastModified - a.n.lastModified));
      
      if (filtered.length === 0) {
        list.innerHTML = '<div class="empty">No matches.</div>';
        return;
      }
      
      for (const {n, idx} of filtered) {
        const item = document.createElement('div');
        item.className = 'noteItem' + (idx === currentIndex ? ' active' : '');
        
        const title = document.createElement('div');
        title.className = 'noteTitle';
        title.textContent = n.title;
        
        const meta = document.createElement('div');
        meta.className = 'noteMeta';
        const firstLine = (n.content || '').split(/\\n/)[0]?.trim() || '';
        const excerpt = firstLine ? firstLine.slice(0, 60) : '(empty)';
        const hasCanvas = n.canvasJson || n.canvasImage || n.image;
        const hasAudio = n.audio;
        let marks = '';
        if (hasCanvas) marks += '  ·  [img]';
        if (hasAudio) marks += '  ·  [audio]';
        meta.textContent = fmtDate(n.lastModified) + '  ·  ' + excerpt + marks;
        
        item.appendChild(title);
        item.appendChild(meta);
        item.onclick = () => openNote(idx);
        list.appendChild(item);
      }
    }
    
    function saveNote() {
      if (currentIndex === null) return;
      const editor = document.getElementById('editor');
      notes[currentIndex].content = editor.value;
      notes[currentIndex].lastModified = Date.now();
      dirty = false;
      document.getElementById('saveState').textContent = 'saved ' + fmtDate(Date.now());
      renderList(document.getElementById('searchInput').value);
      
      // Save to localStorage for persistence
      try {
        localStorage.setItem('noatboat_notes', JSON.stringify(notes));
      } catch(e) {}
    }
    
    function openNote(idx) {
      // Save current note first
      if (currentIndex !== null && dirty) {
        saveNote();
      }
      
      currentIndex = idx;
      const n = notes[idx];
      dirty = false;
      
      document.getElementById('currentTitle').textContent = n.name || n.title;
      document.getElementById('editor').value = n.content || '';
      document.getElementById('saveState').textContent = '';
      document.getElementById('editorWrap').style.display = 'flex';
      document.getElementById('empty').style.display = 'none';
      
      // Handle canvas
      const canvasWrap = document.getElementById('canvasWrap');
      
      if (n.canvasJson || n.canvasImage || n.image) {
        canvasWrap.style.display = 'flex';
        
        // Delay canvas init to allow layout
        setTimeout(() => {
          initCanvas();
          loadCanvasContent(n);
        }, 100);
      } else {
        canvasWrap.style.display = 'none';
        if (fabricCanvas) {
          fabricCanvas.clear();
        }
      }
      
      // Handle audio
      const audioWrap = document.getElementById('audioPlayer');
      const audio = document.getElementById('audio');
      if (n.audio) {
        audioWrap.style.display = 'block';
        audio.src = n.audio;
      } else {
        audioWrap.style.display = 'none';
        audio.src = '';
      }
      
      renderList(document.getElementById('searchInput').value);
    }
    
    function loadCanvasContent(n) {
      if (!fabricCanvas) return;
      
      fabricCanvas.clear();
      
      if (n.canvasJson) {
        try {
          fabricCanvas.loadFromJSON(n.canvasJson, () => {
            // Scale content to fit
            fitCanvasViewport();
            fabricCanvas.renderAll();
          });
        } catch (e) {
          console.error('Failed to load canvas JSON:', e);
          loadCanvasImage(n);
        }
      } else {
        loadCanvasImage(n);
      }
    }
    
    function loadCanvasImage(n) {
      const imgSrc = n.canvasImage || n.image;
      if (!imgSrc || !fabricCanvas) return;
      
      fabric.Image.fromURL(imgSrc, (img) => {
        if (!fabricCanvas || !img) return;
        
        const canvasWidth = fabricCanvas.width;
        const canvasHeight = fabricCanvas.height;
        
        // Scale image to fit within canvas with padding
        const maxWidth = canvasWidth * 0.9;
        const maxHeight = canvasHeight * 0.9;
        
        let scale = 1;
        if (img.width > maxWidth || img.height > maxHeight) {
          scale = Math.min(maxWidth / img.width, maxHeight / img.height);
        }
        
        img.scale(scale);
        img.set({
          left: (canvasWidth - img.getScaledWidth()) / 2,
          top: (canvasHeight - img.getScaledHeight()) / 2,
          selectable: true
        });
        
        fabricCanvas.add(img);
        fabricCanvas.renderAll();
      }, null, { crossOrigin: 'anonymous' });
    }
    
    function fitCanvasViewport(padding = 24) {
      if (!fabricCanvas) return;

      const objects = fabricCanvas.getObjects();
      if (!objects || objects.length === 0) {
        fabricCanvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
        fabricCanvas.requestRenderAll();
        return;
      }

      // Compute overall bounds in canvas coords (include transforms)
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      objects.forEach(obj => {
        const r = obj.getBoundingRect(true, true);
        minX = Math.min(minX, r.left);
        minY = Math.min(minY, r.top);
        maxX = Math.max(maxX, r.left + r.width);
        maxY = Math.max(maxY, r.top + r.height);
      });

      const contentW = Math.max(1, maxX - minX);
      const contentH = Math.max(1, maxY - minY);

      const cw = fabricCanvas.getWidth();
      const ch = fabricCanvas.getHeight();

      const availW = Math.max(1, cw - padding * 2);
      const availH = Math.max(1, ch - padding * 2);

      const scale = Math.min(availW / contentW, availH / contentH);

      // Center content
      const contentCx = minX + contentW / 2;
      const contentCy = minY + contentH / 2;
      const tx = (cw / 2) - (contentCx * scale);
      const ty = (ch / 2) - (contentCy * scale);

      fabricCanvas.setViewportTransform([scale, 0, 0, scale, tx, ty]);
      fabricCanvas.requestRenderAll();
    }

    function initCanvas() {
      const container = document.getElementById('canvasContainer');
      const rect = container.getBoundingClientRect();
      
      const width = Math.max(Math.floor(rect.width), 400);
      const height = Math.max(Math.floor(rect.height), 300);
      
      if (fabricCanvas) {
        // Resize existing canvas
        fabricCanvas.setDimensions({ width: width, height: height });
        fabricCanvas.renderAll();
        return;
      }
      
      const canvasEl = document.getElementById('fabricCanvas');
      canvasEl.width = width;
      canvasEl.height = height;
      
      fabricCanvas = new fabric.Canvas('fabricCanvas', {
        width: width,
        height: height,
        backgroundColor: null,
        selection: true,
        preserveObjectStacking: true
      });
      
      fabricCanvas.freeDrawingBrush.width = 3;
      fabricCanvas.freeDrawingBrush.color = '#000000';
    }
    
    function setDrawingMode(on) {
      if (!fabricCanvas) return;
      fabricCanvas.isDrawingMode = on;
      document.getElementById('selectBtn').classList.toggle('active', !on);
      document.getElementById('drawBtn').classList.toggle('active', on);
    }
    
    // Handle window resize
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (fabricCanvas && currentIndex !== null) {
          const container = document.getElementById('canvasContainer');
          const rect = container.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            fabricCanvas.setDimensions({ width: rect.width, height: rect.height });
            // Reload content to rescale
            const n = notes[currentIndex];
            if (n) loadCanvasContent(n);
          }
        }
      }, 200);
    });
    
    document.addEventListener('DOMContentLoaded', () => {
      // Try to load saved notes from localStorage
      try {
        const saved = localStorage.getItem('noatboat_notes');
        if (saved) {
          const savedNotes = JSON.parse(saved);
          // Merge: keep content changes but preserve original structure
          notes = notes.map((n, i) => {
            const savedNote = savedNotes.find(s => s.id === n.id || s.title === n.title);
            if (savedNote) {
              return { ...n, content: savedNote.content, lastModified: savedNote.lastModified };
            }
            return n;
          });
        }
      } catch(e) {}
      
      renderList();
      
      const searchInput = document.getElementById('searchInput');
      searchInput.addEventListener('input', (e) => {
        renderList(e.target.value);
      });
      
      const editor = document.getElementById('editor');
      editor.addEventListener('input', () => {
        if (currentIndex === null) return;
        dirty = true;
        document.getElementById('saveState').textContent = 'modified';
      });
      
      // Auto-save on blur
      editor.addEventListener('blur', () => {
        if (dirty) saveNote();
      });
      
      // Auto-save periodically
      setInterval(() => {
        if (dirty) saveNote();
      }, 5000);
      
      document.getElementById('selectBtn')?.addEventListener('click', () => setDrawingMode(false));
      document.getElementById('drawBtn')?.addEventListener('click', () => setDrawingMode(true));
      
      if (notes.length > 0) {
        openNote(0);
      }
    });
  `;
}

function generateExportHtml(title, notesJson, css, js, isDark, publishingName = '') {
  // Build the Noat Boat branding with optional owner name
  const noatBoatTitle = publishingName ? `${escapeHtml(publishingName)}'s Noat Boat` : 'Noat Boat';
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - ${noatBoatTitle} Export</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/fabric.js/5.3.1/fabric.min.js"></script>
  <style>${css}</style>
</head>
<body class="${isDark ? 'dark' : ''}">
  <div class="topbar">
    <input id="searchInput" class="search" placeholder="Search notes..." />
    <span style="flex:1;"></span>
    <span style="font-size:13px;color:${isDark ? '#999' : '#666'};">📓 ${escapeHtml(title)} - ${noatBoatTitle}</span>
  </div>
  
  <div class="main">
    <div class="left">
      <div class="list" id="list"></div>
    </div>
    <div class="right">
      <div class="editorHeader">
        <div id="currentTitle" class="currentTitle">Select a note</div>
        <div id="saveState" class="saveState"></div>
      </div>
      <div id="empty" class="empty">Select a note from the list.</div>
      <div id="editorWrap" class="editorWrap" style="display:none;">
        <textarea id="editor" spellcheck="false"></textarea>
        <div id="canvasWrap" class="canvasWrap" style="display:none;">
          <div class="canvasToolbar">
            <button id="selectBtn" class="btn active" title="Select/Move">🖱️</button>
            <button id="drawBtn" class="btn" title="Draw">✏️</button>
          </div>
          <div id="canvasContainer" class="canvasContainer">
            <canvas id="fabricCanvas"></canvas>
          </div>
          <div id="audioPlayer" class="audioPlayer" style="display:none;">
            <audio id="audio" controls loop></audio>
          </div>
        </div>
      </div>
    </div>
  </div>
  
  <script>
    window.NOTES_DATA = ${JSON.stringify(notesJson)};
    ${js}
  </script>
</body>
</html>`;
}