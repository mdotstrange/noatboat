const { app, BrowserWindow, ipcMain, dialog, nativeImage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os'); // Added for temp file handling

// Config file path for storing preferences (like last folder)
const configPath = path.join(app.getPath('userData'), 'config.json');

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
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    fullscreen: true,
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
    // Ensure app menu (and its shortcuts like Cmd/Ctrl+,) exists
    mainWindow.setMenuBarVisibility(true);
    // Some environments behave more reliably if you call it here too:
    mainWindow.setFullScreen(true);
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
  return {
    theme: config.theme || 'light',
    focusStrength: config.focusStrength !== undefined ? config.focusStrength : 70,
    autoFixMode: config.autoFixMode || 'off',
    autoFixEnabled: config.autoFixEnabled || false, // Legacy support
    autoFixProvider: config.autoFixProvider || 'openai',
    openAIKey: config.openAIKey || '',
    localModelPath: config.localModelPath || ''
  };
});

// Save preferences
ipcMain.handle('save-preferences', async (event, prefs) => {
  const config = loadConfig();
  if (prefs.theme !== undefined) config.theme = prefs.theme;
  if (prefs.focusStrength !== undefined) config.focusStrength = prefs.focusStrength;
  if (prefs.autoFixMode !== undefined) config.autoFixMode = prefs.autoFixMode;
  if (prefs.autoFixProvider !== undefined) config.autoFixProvider = prefs.autoFixProvider;
  if (prefs.openAIKey !== undefined) config.openAIKey = prefs.openAIKey;
  if (prefs.localModelPath !== undefined) config.localModelPath = prefs.localModelPath;
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

// Read all files from a folder (now includes subdirectories)
ipcMain.handle('read-folder', async (event, folderPath) => {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    const files = [];
    const folders = [];
    
    for (const entry of entries) {
      const fullPath = path.join(folderPath, entry.name);
      
      // Handle directories
      if (entry.isDirectory()) {
        // Skip hidden folders (starting with .)
        if (entry.name.startsWith('.')) continue;
        
        const stats = fs.statSync(fullPath);
        folders.push({
          name: entry.name,
          type: 'folder',
          path: fullPath,
          lastModified: stats.mtimeMs
        });
        continue;
      }
      
      if (!entry.isFile()) continue;
      
      const stats = fs.statSync(fullPath);
      const lower = entry.name.toLowerCase();
      
      if (lower.endsWith('.txt')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        files.push({
          name: entry.name,
          type: 'text',
          content: content,
          size: stats.size,
          lastModified: stats.mtimeMs
        });
      } else if (/\.(png|jpg|jpeg|gif|webp)$/i.test(entry.name) && !lower.endsWith('.canvas.png')) {
        files.push({
          name: entry.name,
          type: 'image',
          size: stats.size,
          lastModified: stats.mtimeMs
        });
      } else if (/\.(mp3|wav|aiff|aif|ogg|m4a|flac|wma)$/i.test(entry.name)) {
        files.push({
          name: entry.name,
          type: 'audio',
          size: stats.size,
          lastModified: stats.mtimeMs
        });
      } else if (lower.endsWith('.canvas.json')) {
        files.push({
          name: entry.name,
          type: 'canvas',
          size: stats.size,
          lastModified: stats.mtimeMs
        });
      }
    }
    
    return { success: true, files: files, folders: folders };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Read a single file
ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
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

// Check if file exists
ipcMain.handle('file-exists', async (event, filePath) => {
  return fs.existsSync(filePath);
});

// Read image as base64 data URL
ipcMain.handle('read-image-base64', async (event, filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().slice(1);
    let mimeType = 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
    else if (ext === 'gif') mimeType = 'image/gif';
    else if (ext === 'webp') mimeType = 'image/webp';
    
    const base64 = buffer.toString('base64');
    return { success: true, dataUrl: `data:${mimeType};base64,${base64}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Write image from buffer (for drawings)
ipcMain.handle('write-image-buffer', async (event, filePath, base64Data) => {
  try {
    // base64Data is the data URL, strip the prefix
    const base64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
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

// Read audio as base64 data URL
ipcMain.handle('read-audio-base64', async (event, filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().slice(1);
    let mimeType = 'audio/mpeg';
    if (ext === 'wav') mimeType = 'audio/wav';
    else if (ext === 'aiff' || ext === 'aif') mimeType = 'audio/aiff';
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
    fs.writeFileSync(filePath, buffer);
    const stats = fs.statSync(filePath);
    return { success: true, lastModified: stats.mtimeMs, size: stats.size };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Read canvas JSON
ipcMain.handle('read-canvas-json', async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: true, data: null };
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return { success: true, data: content };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Write canvas JSON
ipcMain.handle('write-canvas-json', async (event, filePath, jsonData) => {
  try {
    fs.writeFileSync(filePath, jsonData, 'utf8');
    const stats = fs.statSync(filePath);
    return { success: true, lastModified: stats.mtimeMs };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Delete canvas files
ipcMain.handle('delete-canvas-files', async (event, basePath) => {
  try {
    const jsonPath = basePath + '.canvas.json';
    const pngPath = basePath + '.canvas.png';
    if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
    if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath);
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
    
    for (let i = 0; i < notesData.length; i++) {
      const note = notesData[i];
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
audio { width: 100%; margin: 1em 0; }
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
      let audioTag = '';
      
      // Handle image
      if (note.imageDataUrl) {
        const match = note.imageDataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
          const imgFileName = `img${i}.${ext}`;
          const imgBuffer = Buffer.from(match[2], 'base64');
          addFile(`OEBPS/images/${imgFileName}`, imgBuffer);
          
          const mimeType = `image/${match[1]}`;
          manifestItems.push(`<item id="img${i}" href="images/${imgFileName}" media-type="${mimeType}"/>`);
          imageTag = `<p><img class="note-image" src="images/${imgFileName}" alt="${escapeHtml(note.title)}"/></p>`;
        }
      }
      
      // Handle audio
      if (note.audioDataUrl) {
        const match = note.audioDataUrl.match(/^data:audio\/([^;]+);base64,(.+)$/);
        if (match) {
          let ext = match[1];
          if (ext === 'mpeg') ext = 'mp3';
          if (ext === 'mp4') ext = 'm4a';
          const audioFileName = `audio${i}.${ext}`;
          const audioBuffer = Buffer.from(match[2], 'base64');
          addFile(`OEBPS/audio/${audioFileName}`, audioBuffer);
          
          const mimeType = `audio/${match[1]}`;
          manifestItems.push(`<item id="audio${i}" href="audio/${audioFileName}" media-type="${mimeType}"/>`);
          audioTag = `<p><audio controls src="audio/${audioFileName}">Audio</audio></p>`;
        }
      }
      
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
  ${audioTag}
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
    // Create assets folder
    const assetsDir = path.join(saveDir, 'assets');
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
    }
    
    // Write assets
    for (const asset of assets) {
      const match = asset.dataUrl.match(/^data:[^;]+;base64,(.+)$/);
      if (match) {
        const buffer = Buffer.from(match[1], 'base64');
        fs.writeFileSync(path.join(assetsDir, asset.name), buffer);
      }
    }
    
    // Generate notes JSON for the app
    const notesJson = notesData.map(n => ({
      id: n.id,
      title: n.title,
      name: n.name,
      content: n.content,
      lastModified: n.lastModified,
      canvasJson: n.canvasJson || null,
      canvasImage: n.canvasImage ? `assets/${n.canvasImage}` : null,
      image: n.image ? `assets/${n.image}` : null,
      audio: n.audio ? `assets/${n.audio}` : null
    }));
    
    // CSS styles
    const cssContent = generateExportCss(isDark);
    
    // JavaScript for the app
    const jsContent = generateExportJs();
    
    // Main HTML
    const htmlContent = generateExportHtml(bookTitle, notesJson, cssContent, jsContent, isDark);
    
    fs.writeFileSync(path.join(saveDir, 'index.html'), htmlContent);
    
    // Copy fabric.min.js if it exists
    const fabricPath = path.join(__dirname, 'fabric.min.js');
    if (fs.existsSync(fabricPath)) {
      fs.copyFileSync(fabricPath, path.join(saveDir, 'fabric.min.js'));
    }
    
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
      background: ${bgColor};
      color: ${textColor};
      height: 100vh;
      overflow: hidden;
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
      background: ${editorBg};
      color: ${textColor};
      border-radius: 8px;
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
      background: ${editorBg};
      min-height: 0;
    }
    .canvasContainer canvas { display: block; }
    .canvasContainer .canvas-container { 
      position: absolute !important;
      width: 100% !important;
      height: 100% !important;
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
            scaleCanvasContent();
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
    
    function scaleCanvasContent() {
      if (!fabricCanvas) return;
      
      const objects = fabricCanvas.getObjects();
      if (objects.length === 0) return;
      
      // Get bounding box of all objects
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      
      objects.forEach(obj => {
        const bound = obj.getBoundingRect();
        minX = Math.min(minX, bound.left);
        minY = Math.min(minY, bound.top);
        maxX = Math.max(maxX, bound.left + bound.width);
        maxY = Math.max(maxY, bound.top + bound.height);
      });
      
      const contentWidth = maxX - minX;
      const contentHeight = maxY - minY;
      
      if (contentWidth <= 0 || contentHeight <= 0) return;
      
      const canvasWidth = fabricCanvas.width;
      const canvasHeight = fabricCanvas.height;
      
      // Check if content is larger than canvas
      if (contentWidth > canvasWidth * 0.95 || contentHeight > canvasHeight * 0.95) {
        const scale = Math.min(
          (canvasWidth * 0.85) / contentWidth,
          (canvasHeight * 0.85) / contentHeight
        );
        
        // Scale all objects
        const centerX = canvasWidth / 2;
        const centerY = canvasHeight / 2;
        const contentCenterX = minX + contentWidth / 2;
        const contentCenterY = minY + contentHeight / 2;
        
        objects.forEach(obj => {
          const objCenterX = obj.left + (obj.width * obj.scaleX) / 2;
          const objCenterY = obj.top + (obj.height * obj.scaleY) / 2;
          
          const newCenterX = centerX + (objCenterX - contentCenterX) * scale;
          const newCenterY = centerY + (objCenterY - contentCenterY) * scale;
          
          obj.scaleX *= scale;
          obj.scaleY *= scale;
          obj.left = newCenterX - (obj.width * obj.scaleX) / 2;
          obj.top = newCenterY - (obj.height * obj.scaleY) / 2;
          obj.setCoords();
        });
      }
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

function generateExportHtml(title, notesJson, css, js, isDark) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Noat Boat Export</title>
  <script src="fabric.min.js"></script>
  <style>${css}</style>
</head>
<body class="${isDark ? 'dark' : ''}">
  <div class="topbar">
    <input id="searchInput" class="search" placeholder="Search notes..." />
    <span style="flex:1;"></span>
    <span style="font-size:13px;color:${isDark ? '#999' : '#666'};">📓 ${escapeHtml(title)}</span>
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