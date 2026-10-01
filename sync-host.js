// Runs sync passes in their own process (Electron utilityProcess), so a
// network drive that stops answering mid-read can only stall this process;
// main.js notices the silence and kills it.
//
// In:  { type: 'sync', id, opts }      opts as sync-engine syncOnce
//      { type: 'setup', id, localRoot, shareRoot }
// Out: { type: 'progress', id, ... }   at least every few seconds while busy
//      { type: 'result', id, result }

const sync = require('./sync-engine');

const port = process.parentPort;

port.on('message', (e) => {
  const msg = e.data || {};
  let result;
  try {
    if (msg.type === 'sync') {
      result = sync.syncOnce({
        ...msg.opts,
        onProgress: (p) => port.postMessage({ type: 'progress', id: msg.id, ...p })
      });
    } else if (msg.type === 'setup') {
      const check = sync.checkLocalFolder(msg.localRoot, msg.shareRoot);
      if (!check.ok) {
        result = { state: 'error', error: check.error };
      } else {
        require('fs').mkdirSync(msg.localRoot, { recursive: true });
        sync.initShare(msg.shareRoot);
        sync.initLocal(msg.localRoot, msg.shareRoot);
        result = { state: 'ok', existing: !!check.existing };
      }
    } else {
      result = { state: 'error', error: `Unknown request: ${msg.type}` };
    }
  } catch (err) {
    result = { state: 'error', error: String((err && err.message) || err) };
  }
  port.postMessage({ type: 'result', id: msg.id, result });
});
