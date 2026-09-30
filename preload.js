const { contextBridge, ipcRenderer, webUtils } = require('electron');
const path = require('path');

contextBridge.exposeInMainWorld('electronAPI', {
  // Folder operations
  getSavedFolder: () => ipcRenderer.invoke('get-saved-folder'),
  saveFolderPath: (folderPath) => ipcRenderer.invoke('save-folder-path', folderPath),
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  readFolder: (folderPath, opts) => ipcRenderer.invoke('read-folder', folderPath, opts || {}),
  calendarScan: (rootPath) => ipcRenderer.invoke('calendar-scan', rootPath),
  
  // File operations
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content, opts) => ipcRenderer.invoke('write-file', filePath, content, opts || {}),
  noteDiskState: (filePath) => ipcRenderer.invoke('note-disk-state', filePath),
  noteDiskContent: (notePath) => ipcRenderer.invoke('note-disk-content', notePath),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  moveNote: (srcFolder, baseName, destFolder) => ipcRenderer.invoke('move-note', srcFolder, baseName, destFolder),
  fileExists: (filePath) => ipcRenderer.invoke('file-exists', filePath),
  fileSize: (filePath) => ipcRenderer.invoke('file-size', filePath),
  createFolder: (folderPath) => ipcRenderer.invoke('create-folder', folderPath),
  
  // Image operations
  readImageBase64: (filePath) => ipcRenderer.invoke('read-image-base64', filePath),
  readImageThumbnail: (filePath, maxWidth) => ipcRenderer.invoke('read-image-thumbnail', filePath, maxWidth || 512),
  writeImageBuffer: (filePath, base64Data) => ipcRenderer.invoke('write-image-buffer', filePath, base64Data),
  copyImage: (srcPath, destPath) => ipcRenderer.invoke('copy-image', srcPath, destPath),
  openImageDialog: () => ipcRenderer.invoke('open-image-dialog'),
  
  // Audio operations
  readAudioBase64: (filePath) => ipcRenderer.invoke('read-audio-base64', filePath),
  writeAudioBuffer: (filePath, base64Data) => ipcRenderer.invoke('write-audio-buffer', filePath, base64Data),
  openAudioDialog: () => ipcRenderer.invoke('open-audio-dialog'),
  // Audio transcoding / playback helpers
  getAudioPlaybackUrl: (filePath, options) => ipcRenderer.invoke('get-audio-playback-url', filePath, options || {}),
  transcodeAudioToMp3DataUrl: (filePath, bitrateKbps) => ipcRenderer.invoke('transcode-audio-to-mp3-dataurl', filePath, bitrateKbps || 128),

  // Canvas operations
  readCanvasJson: (filePath) => ipcRenderer.invoke('read-canvas-json', filePath),
  writeCanvasJson: (filePath, jsonData, opts) => ipcRenderer.invoke('write-canvas-json', filePath, jsonData, opts || {}),
  deleteCanvasFiles: (basePath) => ipcRenderer.invoke('delete-canvas-files', basePath),
  
  // Preferences
  getPreferences: () => ipcRenderer.invoke('get-preferences'),
  savePreferences: (prefs) => ipcRenderer.invoke('save-preferences', prefs),
  onOpenPreferences: (callback) => ipcRenderer.on('open-preferences', callback),

  // Notes encryption
  vaultStatus: (folder, opts) => ipcRenderer.invoke('vault-status', folder, opts || {}),
  vaultEnable: (folder, password, remember) => ipcRenderer.invoke('vault-enable', folder, password, remember),
  vaultUnlock: (folder, password, remember) => ipcRenderer.invoke('vault-unlock', folder, password, remember),
  vaultChangePassword: (folder, oldPassword, newPassword) => ipcRenderer.invoke('vault-change-password', folder, oldPassword, newPassword),
  vaultForgetKey: (folder) => ipcRenderer.invoke('vault-forget-key', folder),
  vaultDisable: (folder, password) => ipcRenderer.invoke('vault-disable', folder, password),
  onVaultProgress: (callback) => ipcRenderer.on('vault-progress', (_event, payload) => callback(payload)),
  vaultHwUnlock: (folder, slotId, remember) => ipcRenderer.invoke('vault-hw-unlock', folder, slotId, remember),
  vaultSlotAdd: (folder, type, password, opts) => ipcRenderer.invoke('vault-slot-add', folder, type, password, opts || {}),
  vaultSlotRemove: (folder, slotId) => ipcRenderer.invoke('vault-slot-remove', folder, slotId),
  vaultTouchIdSet: (folder, on) => ipcRenderer.invoke('vault-touchid-set', folder, on),
  onVaultHwEvent: (callback) => ipcRenderer.on('vault-hw-event', (_event, payload) => callback(payload)),
  onVaultHwPrompt: (callback) => ipcRenderer.on('vault-hw-prompt', (_event, payload) => callback(payload)),
  vaultHwPromptReply: (id, value) => ipcRenderer.send('vault-hw-prompt-reply', id, value),
  
  // Local LLM / DeepSeek
  openModelDialog: () => ipcRenderer.invoke('open-model-dialog'),
  runLocalLLM: (modelPath, text) => ipcRenderer.invoke('run-local-llm', modelPath, text),
  deepseekChat: (opts) => ipcRenderer.invoke('deepseek-chat', opts),

  // IC recorder import
  openWhisperCliDialog: () => ipcRenderer.invoke('open-whisper-cli-dialog'),
  openWhisperModelDialog: () => ipcRenderer.invoke('open-whisper-model-dialog'),
  icImportScan: (opts) => ipcRenderer.invoke('ic-import-scan', opts),
  icImportRun: (opts) => ipcRenderer.invoke('ic-import-run', opts),
  icImportCancel: () => ipcRenderer.invoke('ic-import-cancel'),
  onIcImportProgress: (callback) => ipcRenderer.on('ic-import-progress', (_event, payload) => callback(payload)),
  // Per-note background AI jobs (Transcribe Audio / Format Text)
  noteAiStart: (opts) => ipcRenderer.invoke('note-ai-start', opts),
  noteAiList: () => ipcRenderer.invoke('note-ai-list'),
  noteAiWriteResult: (opts) => ipcRenderer.invoke('note-ai-write-result', opts),
  onNoteAiProgress: (callback) => ipcRenderer.on('note-ai-progress', (_event, payload) => callback(payload)),
  // Send note to Uberector's inbox folder
  uberectorSend: (dir, text) => ipcRenderer.invoke('uberector-send', dir, text),

  // Dialog operations
  showPrompt: (message, defaultValue) => ipcRenderer.invoke('show-prompt', message, defaultValue),
  showConfirm: (message, opts) => ipcRenderer.invoke('show-confirm', message, opts || {}),
  showAlert: (message) => ipcRenderer.invoke('show-alert', message),
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),

  // Backup
  backupNotes: (folder) => ipcRenderer.invoke('backup-notes', folder),
  onBackupProgress: (callback) => ipcRenderer.on('backup-progress', (_event, payload) => callback(payload)),
  
  // Export operations
  exportPdf: (savePath, notesData, isDark) => ipcRenderer.invoke('export-pdf', savePath, notesData, isDark),
  exportPng: (filePath, noteData, isDark) => ipcRenderer.invoke('export-png', filePath, noteData, isDark),
  exportEpub: (savePath, bookTitle, notesData, isDark) => ipcRenderer.invoke('export-epub', savePath, bookTitle, notesData, isDark),
  exportHtml: (saveDir, bookTitle, notesData, assets, isDark) => ipcRenderer.invoke('export-html', saveDir, bookTitle, notesData, assets, isDark),
  
  // File drag and drop - get path from File object
  getPathForFile: (file) => webUtils.getPathForFile(file),
  
  // Open file in OS file explorer
  showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),
  openPath: (filePath) => ipcRenderer.invoke('open-path', filePath),
  
  // Path utilities
  joinPath: (...parts) => path.join(...parts),
  basename: (p, ext) => path.basename(p, ext),
  extname: (p) => path.extname(p),
  dirname: (p) => path.dirname(p)
});