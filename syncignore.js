// Which files in a notes folder belong to Noat Boat and get copied around
// (Backup zips, sync between the local copy and the network drive).
// No Electron imports: the sync process and the tests load this too.

const NOATFORMAT_DIR = '.noatformat';
const SYNC_DIR = '.noatsync';

// Hidden folders other than .noatformat (.git, .dropbox.cache, .noatsync, ...).
function skipDir(name) {
  return name.startsWith('.') && name !== NOATFORMAT_DIR;
}

// Hidden files (.DS_Store, ._ AppleDouble files), Windows clutter, and the
// temp files of interrupted writes, migrations and zips.
function skipFile(name) {
  const lower = name.toLowerCase();
  return name.startsWith('.') || lower === 'desktop.ini' || lower === 'thumbs.db' ||
    lower.endsWith('.tmp') || lower.endsWith('.partial') || lower.endsWith('.noatvault-tmp');
}

// Sync also leaves out each computer's own encryption lock: it says "this
// computer is converting its copy right now", which means nothing elsewhere.
function syncSkipFile(name, parentName) {
  return skipFile(name) || (parentName === NOATFORMAT_DIR && name.toLowerCase() === 'vault.lock');
}

module.exports = { NOATFORMAT_DIR, SYNC_DIR, skipDir, skipFile, syncSkipFile };
