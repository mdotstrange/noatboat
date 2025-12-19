const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('promptAPI', {
  onSetPrompt: (callback) => {
    ipcRenderer.on('set-prompt', (event, message, defaultValue) => {
      callback(message, defaultValue);
    });
  },
  sendResponse: (result) => {
    ipcRenderer.send('prompt-response', result);
  }
});