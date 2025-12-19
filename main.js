const { app, BrowserWindow, ipcMain, dialog, nativeImage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

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

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    // Some environments behave more reliably if you call it here too:
    mainWindow.setFullScreen(true);
    mainWindow.show();
  });
}
npm

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
    autoFixEnabled: config.autoFixEnabled || false,
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
  if (prefs.autoFixEnabled !== undefined) config.autoFixEnabled = prefs.autoFixEnabled;
  if (prefs.autoFixProvider !== undefined) config.autoFixProvider = prefs.autoFixProvider;
  if (prefs.openAIKey !== undefined) config.openAIKey = prefs.openAIKey;
  if (prefs.localModelPath !== undefined) config.localModelPath = prefs.localModelPath;
  saveConfig(config);
  return true;
});

// Open model file picker dialog
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

// Run local LLM inference
let llamaInstance = null;
let llamaModel = null;
let llamaModelPath = null;

ipcMain.handle('run-local-llm', async (event, modelPath, text) => {
  try {
    // Dynamically import node-llama-cpp (ES module)
    const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
    
    // Load or reload model if path changed
    if (llamaModelPath !== modelPath || !llamaModel) {
      if (llamaModel) {
        // Dispose old model
        try {
          await llamaModel.dispose();
        } catch (_e) {}
      }
      
      console.log('Loading GGUF model:', modelPath);
      llamaInstance = await getLlama();
      llamaModel = await llamaInstance.loadModel({ modelPath });
      llamaModelPath = modelPath;
      console.log('Model loaded successfully');
    }
    
    const context = await llamaModel.createContext();
    
    // System prompt needs to be in the constructor for node-llama-cpp v3
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: 'You fix spelling and grammar errors. Output only the corrected text, nothing else.'
    });
    
    // Simple, direct prompt for small models
    const prompt = `Fix any spelling and grammar errors in this text. Return ONLY the corrected text:\n\n${text}`;
    
    console.log('Running inference...');
    const response = await session.prompt(prompt, {
      maxTokens: Math.min(text.length * 2, 2048),
      temperature: 0.1
    });
    console.log('Inference complete, response length:', response?.length);
    
    await context.dispose();
    
    // Clean up the response - remove any extra whitespace or quotes
    let cleanedResponse = response?.trim() || '';
    
    // Remove surrounding quotes if present
    if ((cleanedResponse.startsWith('"') && cleanedResponse.endsWith('"')) ||
        (cleanedResponse.startsWith("'") && cleanedResponse.endsWith("'"))) {
      cleanedResponse = cleanedResponse.slice(1, -1);
    }
    
    // If response is empty or way too different in length, return original
    if (!cleanedResponse || cleanedResponse.length < text.length * 0.3 || cleanedResponse.length > text.length * 3) {
      console.log('Response seems invalid, returning original text');
      return { success: true, text: text };
    }
    
    return { success: true, text: cleanedResponse };
  } catch (err) {
    console.error('Local LLM error:', err);
    return { success: false, error: err.message };
  }
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

// Read all files from a folder
ipcMain.handle('read-folder', async (event, folderPath) => {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    const files = [];
    
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      
      const filePath = path.join(folderPath, entry.name);
      const stats = fs.statSync(filePath);
      const lower = entry.name.toLowerCase();
      
      if (lower.endsWith('.txt')) {
        const content = fs.readFileSync(filePath, 'utf8');
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
    
    return { success: true, files: files };
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