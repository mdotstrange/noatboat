const { contextBridge, ipcRenderer, webUtils } = require('electron');
const path = require('path');

contextBridge.exposeInMainWorld('electronAPI', {
  // Folder operations
  getSavedFolder: () => ipcRenderer.invoke('get-saved-folder'),
  saveFolderPath: (folderPath) => ipcRenderer.invoke('save-folder-path', folderPath),
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  readFolder: (folderPath) => ipcRenderer.invoke('read-folder', folderPath),
  
  // File operations
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  fileExists: (filePath) => ipcRenderer.invoke('file-exists', filePath),
  
  // Image operations
  readImageBase64: (filePath) => ipcRenderer.invoke('read-image-base64', filePath),
  writeImageBuffer: (filePath, base64Data) => ipcRenderer.invoke('write-image-buffer', filePath, base64Data),
  copyImage: (srcPath, destPath) => ipcRenderer.invoke('copy-image', srcPath, destPath),
  openImageDialog: () => ipcRenderer.invoke('open-image-dialog'),
  
  // Audio operations
  readAudioBase64: (filePath) => ipcRenderer.invoke('read-audio-base64', filePath),
  writeAudioBuffer: (filePath, base64Data) => ipcRenderer.invoke('write-audio-buffer', filePath, base64Data),
  openAudioDialog: () => ipcRenderer.invoke('open-audio-dialog'),
  
  // Canvas operations
  readCanvasJson: (filePath) => ipcRenderer.invoke('read-canvas-json', filePath),
  writeCanvasJson: (filePath, jsonData) => ipcRenderer.invoke('write-canvas-json', filePath, jsonData),
  deleteCanvasFiles: (basePath) => ipcRenderer.invoke('delete-canvas-files', basePath),
  
  // Preferences
  getPreferences: () => ipcRenderer.invoke('get-preferences'),
  savePreferences: (prefs) => ipcRenderer.invoke('save-preferences', prefs),
  onOpenPreferences: (callback) => ipcRenderer.on('open-preferences', callback),
  
  // Local LLM
  openModelDialog: () => ipcRenderer.invoke('open-model-dialog'),
  runLocalLLM: (modelPath, text) => ipcRenderer.invoke('run-local-llm', modelPath, text),
  
  // Dialog operations
  showPrompt: (message, defaultValue) => ipcRenderer.invoke('show-prompt', message, defaultValue),
  showConfirm: (message) => ipcRenderer.invoke('show-confirm', message),
  showAlert: (message) => ipcRenderer.invoke('show-alert', message),
  
  // File drag and drop - get path from File object
  getPathForFile: (file) => webUtils.getPathForFile(file),
  
  // Path utilities
  joinPath: (...parts) => path.join(...parts),
  basename: (p, ext) => path.basename(p, ext),
  extname: (p) => path.extname(p)
});