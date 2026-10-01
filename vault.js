// Client-side encryption for the notes folder ("vault").
//
// A vault is a notes folder with <root>/.noatformat/vault.json. That file holds
// a random 256-bit data key wrapped (AES-256-GCM) by a key derived from the
// user's password with PBKDF2-HMAC-SHA256. Files are encrypted with the data
// key, so changing the password only re-wraps vault.json.
//
// Extra unlock methods (YubiKey, Trezor) are "slots" in vault.json: each wraps
// the same data key with a KEK derived (HKDF-SHA256) from a secret the device
// returns for the slot's stored salt. Any one slot, or the password, unlocks.
//
// Encrypted file layout: MAGIC (8) | IV (12) | ciphertext | GCM tag (16).
// Reads detect MAGIC and pass plaintext through, so plaintext and encrypted
// files can coexist (interrupted migrations, turning encryption off).
//
// Known limits (by design): file contents are not bound to file names, so
// someone with write access to the synced folder can swap two notes'
// ciphertexts; a YubiKey slot without "require touch" answers any local
// process; ffmpeg/whisper work on plaintext copies in the session temp dir.
//
// No Electron imports here: main.js injects what it needs, and the tests run
// under plain node.

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const MAGIC = Buffer.from('NOATENC\x01', 'latin1');
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SALT_LEN = 16;
const NOATFORMAT_DIR = '.noatformat';
const VAULT_FILE = 'vault.json';
// Present while a computer encrypts or decrypts the folder, so other computers
// sharing it (network drive) hold their writes until it is done.
const LOCK_FILE = 'vault.lock';
const LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_BEAT_MS = 30 * 1000;
const PBKDF2_ITERATIONS = 600000;
const MIN_PASSWORD_LEN = 8;
const MIGRATE_TMP_SUFFIX = '.noatvault-tmp';
const PARTIAL_SUFFIX = '.partial';
// <file>.<original mtime ms>.noatvault-tmp: complete target bytes of an
// in-place rewrite, written before the file itself is touched.
const MIGRATE_TMP_RE = /^(.+)\.(\d+)\.noatvault-tmp$/;

class LockedError extends Error {
  constructor(p) {
    super('Notes are encrypted - unlock them in Preferences > Encryption');
    this.code = 'VAULT_LOCKED';
    this.locked = true;
    this.path = p;
  }
}

class WrongPasswordError extends Error {
  constructor() {
    super('Wrong password');
    this.code = 'VAULT_WRONG_PASSWORD';
  }
}

class WrongKeyError extends Error {
  constructor() {
    super('This key does not unlock these notes');
    this.code = 'VAULT_WRONG_KEY';
  }
}

// vault.json's password slot unwraps to a key that is not this vault's key.
class KeyMismatchError extends Error {
  constructor() {
    super('vault.json is inconsistent - the password does not match this vault\'s key');
    this.code = 'VAULT_KEY_MISMATCH';
  }
}

// A migration is rewriting the folder; writes must wait so neither side
// clobbers the other. host: the other computer doing it, if not this one.
class BusyError extends Error {
  constructor(p, host) {
    super(host
      ? `Notes are being encrypted or decrypted on ${host} - try again in a moment`
      : 'Notes are being encrypted or decrypted - try again in a moment');
    this.code = 'VAULT_BUSY';
    this.path = p;
  }
}

function checkPassword(password) {
  const s = String(password || '');
  if (!s) throw new Error('Password is empty');
  if (s.length < MIN_PASSWORD_LEN) throw new Error(`Use at least ${MIN_PASSWORD_LEN} characters`);
}

// Salt size per slot type: a YubiKey HMAC challenge is always 64 bytes.
const SLOT_SALT_LEN = { yubikey: 64, trezor: 32 };

// ---------------------------------------------------------------------------
// Primitives

function isEncrypted(buf) {
  return !!buf && buf.length >= MAGIC.length + IV_LEN + TAG_LEN &&
    buf.subarray(0, MAGIC.length).equals(MAGIC);
}

function encryptBuf(key, plain) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(MAGIC);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, ct, c.getAuthTag()]);
}

function decryptBuf(key, buf) {
  if (!isEncrypted(buf)) throw new Error('Not an encrypted file');
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(MAGIC.length + IV_LEN, buf.length - TAG_LEN);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(MAGIC);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// NFC so the same password typed on different platforms/keyboards derives
// the same key.
function deriveKek(password, salt, iterations) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(String(password).normalize('NFC'), salt, iterations, KEY_LEN, 'sha256', (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}

// Public fingerprint of the data key, stored in vault.json so a remembered key
// can be checked against the vault without the password.
function keyId(dataKey) {
  return crypto.createHmac('sha256', dataKey).update('noatboat-vault-key-id').digest('hex');
}

// ---------------------------------------------------------------------------
// vault.json

function vaultFilePath(root) {
  return path.join(root, NOATFORMAT_DIR, VAULT_FILE);
}

function readVaultFile(root) {
  try {
    const v = JSON.parse(fs.readFileSync(vaultFilePath(root), 'utf8'));
    if (v && v.v === 1 && v.salt && v.wrappedKey) return v;
  } catch (_e) {}
  return null;
}

// AES-256-GCM wrap of the data key under a KEK -> { iv, wrappedKey, tag }.
function wrapWithKek(dataKey, kek) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const wrapped = Buffer.concat([c.update(dataKey), c.final()]);
  return {
    iv: iv.toString('base64'),
    wrappedKey: wrapped.toString('base64'),
    tag: c.getAuthTag().toString('base64')
  };
}

// Returns the data key, or null when the KEK is wrong (GCM tag mismatch).
function unwrapWithKek(obj, kek) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(obj.iv, 'base64'));
    d.setAuthTag(Buffer.from(obj.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(obj.wrappedKey, 'base64')), d.final()]);
  } catch (_e) {
    return null;
  }
}

// The password slot lives in vault.json's top-level fields.
async function wrapKey(dataKey, password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const kek = await deriveKek(password, salt, PBKDF2_ITERATIONS);
  return {
    v: 1,
    kdf: 'pbkdf2-sha256',
    iterations: PBKDF2_ITERATIONS,
    salt: salt.toString('base64'),
    ...wrapWithKek(dataKey, kek),
    keyId: keyId(dataKey)
  };
}

async function unwrapKey(vault, password) {
  const kek = await deriveKek(password, Buffer.from(vault.salt, 'base64'), vault.iterations || PBKDF2_ITERATIONS);
  const dataKey = unwrapWithKek(vault, kek);
  if (!dataKey) throw new WrongPasswordError();
  if (vault.keyId && vault.keyId !== keyId(dataKey)) throw new KeyMismatchError();
  return dataKey;
}

// KEK for a hardware slot from the secret the device returned for its salt.
function slotKek(type, secret, salt) {
  return Buffer.from(crypto.hkdfSync('sha256', secret, salt, 'noatboat-slot-' + type, KEY_LEN));
}

function writeVaultFile(root, vault) {
  const p = vaultFilePath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  replaceFileSync(p, Buffer.from(JSON.stringify(vault, null, 2), 'utf8'));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Write bytes to a uniquely named temp file next to p, then rename it over p,
// so a reader on another computer sees either the old or the new file, never
// half of one. A rename blocked by a reader (Windows sharing violation) is
// retried briefly, then the bytes are written in place instead.
function replaceFileSync(p, bytes) {
  const tmp = `${p}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, bytes);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, p);
      return;
    } catch (e) {
      const busy = e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES');
      if (busy && i < 4) { sleepSync(25 * (i + 1)); continue; }
      try {
        if (!busy) throw e;
        fs.writeFileSync(p, bytes);
      } finally {
        try { fs.unlinkSync(tmp); } catch (_e) {}
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-computer migration lock (.noatformat/vault.lock)

function lockFilePath(root) {
  return path.join(root, NOATFORMAT_DIR, LOCK_FILE);
}

// The lock of another computer (or another app instance) that is still being
// refreshed, or null.
function readForeignLock(root) {
  try {
    const l = JSON.parse(fs.readFileSync(lockFilePath(root), 'utf8'));
    if (!l || (l.host === os.hostname() && l.pid === process.pid)) return null;
    if (!(Date.now() - Number(l.at) < LOCK_STALE_MS)) return null; // stale: its owner died
    return l;
  } catch (_e) {
    return null;
  }
}

function writeOwnLock(root) {
  fs.mkdirSync(path.join(root, NOATFORMAT_DIR), { recursive: true });
  fs.writeFileSync(lockFilePath(root), JSON.stringify({ host: os.hostname(), pid: process.pid, at: Date.now() }), 'utf8');
}

function removeOwnLock(root) {
  try {
    const l = JSON.parse(fs.readFileSync(lockFilePath(root), 'utf8'));
    if (l && l.host === os.hostname() && l.pid === process.pid) fs.unlinkSync(lockFilePath(root));
  } catch (_e) {}
}

// ---------------------------------------------------------------------------
// Unlock state. Keys are held per vault root; any path is mapped to the
// nearest ancestor folder that has a vault.json.

const keys = new Map();       // normalised root -> data key
const rootCache = new Map();  // normalised dir -> vault root | null
const migrating = new Set();  // normalised roots with a migration in progress

function norm(p) {
  const r = path.resolve(String(p || ''));
  return (process.platform === 'win32' || process.platform === 'darwin') ? r.toLowerCase() : r;
}

function invalidate() {
  rootCache.clear();
}

// The vault root that covers dir (a folder), or null. fresh skips the cache
// (the result is still cached).
function findVaultRoot(dir, fresh = false) {
  const start = norm(dir);
  if (!fresh && rootCache.has(start)) return rootCache.get(start);
  const visited = [];
  let cur = path.resolve(String(dir));
  let found = null;
  for (;;) {
    const k = norm(cur);
    if (!fresh && rootCache.has(k)) { found = rootCache.get(k); break; }
    visited.push(k);
    if (fs.existsSync(vaultFilePath(cur))) { found = cur; break; }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const k of visited) rootCache.set(k, found);
  return found;
}

function vaultRootForFile(p) {
  return findVaultRoot(path.dirname(path.resolve(String(p))));
}

function keyForRoot(root) {
  return root ? (keys.get(norm(root)) || null) : null;
}

// Forget a root's key and zero the buffer. Callers that keep the key (main.js
// remembers it) copy it first.
function dropKey(root) {
  const k = norm(root);
  const key = keys.get(k);
  if (key) { key.fill(0); keys.delete(k); }
}

// First descendant folder that has its own vault.json, or null.
function findNestedVault(root) {
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return null; }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const sub = path.join(dir, ent.name);
      if (fs.existsSync(vaultFilePath(sub))) return sub;
      const deeper = walk(sub);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(root);
}

function status(root) {
  if (!root) return { state: 'off' };
  const vr = findVaultRoot(root);
  if (!vr) return { state: 'off' };
  return { state: keyForRoot(vr) ? 'unlocked' : 'locked', root: vr };
}

async function createVault(root, password) {
  checkPassword(password);
  invalidate();
  if (findVaultRoot(root)) throw new Error('This folder is already encrypted');
  const nested = findNestedVault(root);
  if (nested) throw new Error(`A subfolder is already encrypted (${path.relative(root, nested)}) - open that folder to manage its encryption`);
  const dataKey = crypto.randomBytes(KEY_LEN);
  writeVaultFile(root, await wrapKey(dataKey, password));
  invalidate();
  keys.set(norm(root), dataKey);
  return dataKey;
}

async function unlockWithPassword(root, password) {
  const vr = findVaultRoot(root);
  const vault = vr && readVaultFile(vr);
  if (!vault) throw new Error('This folder is not encrypted');
  const dataKey = await unwrapKey(vault, password);
  keys.set(norm(vr), dataKey);
  return { root: vr, dataKey };
}

// ---------------------------------------------------------------------------
// Hardware key slots

function publicSlot(s) {
  return { id: s.id, type: s.type, label: s.label || s.type, deviceId: s.deviceId || null, createdAt: s.createdAt || null };
}

// meta.deviceId (YubiKey serial, Trezor device id) identifies the physical key,
// so the same key can't be enrolled twice. Different keys of one type are fine.
function findDuplicateSlot(vault, type, deviceId) {
  if (!deviceId) return null;
  return (vault.slots || []).find(s => s.type === type && s.deviceId === deviceId) || null;
}

class DuplicateKeyError extends Error {
  constructor(label) {
    super(`${label} is already an unlock method for these notes`);
    this.code = 'VAULT_DUPLICATE_KEY';
  }
}

function assertNotEnrolled(root, type, deviceId) {
  const vr = findVaultRoot(root);
  const vault = vr && readVaultFile(vr);
  const dup = vault && findDuplicateSlot(vault, type, deviceId);
  if (dup) throw new DuplicateKeyError(dup.label || type);
}

function listSlots(root) {
  const vr = findVaultRoot(root);
  const vault = vr && readVaultFile(vr);
  return vault ? (vault.slots || []).map(publicSlot) : [];
}

// Full slot (with its salt) so the caller can ask the device for the secret.
function getSlot(root, id) {
  const vr = findVaultRoot(root);
  const vault = vr && readVaultFile(vr);
  const slot = vault && (vault.slots || []).find(s => s.id === id);
  return slot ? { ...slot, salt: Buffer.from(slot.salt, 'base64') } : null;
}

function newSlotSalt(type) {
  return crypto.randomBytes(SLOT_SALT_LEN[type] || 32);
}

// Enroll a slot. The vault must be unlocked: the slot wraps the data key.
// secret is what the device returned for salt.
function addSlot(root, { type, label, salt, meta }, secret) {
  const vr = findVaultRoot(root);
  const dataKey = keyForRoot(vr);
  if (!dataKey) throw new LockedError(root);
  const vault = readVaultFile(vr);
  if (!vault) throw new Error('This folder is not encrypted');
  if (vault.keyId && vault.keyId !== keyId(dataKey)) throw new Error('Vault key mismatch - reopen the folder');
  const dup = findDuplicateSlot(vault, type, meta && meta.deviceId);
  if (dup) throw new DuplicateKeyError(dup.label || type);
  const slot = {
    id: crypto.randomBytes(8).toString('hex'),
    type,
    label: label || type,
    ...(meta || {}),
    salt: Buffer.from(salt).toString('base64'),
    ...wrapWithKek(dataKey, slotKek(type, secret, salt)),
    createdAt: new Date().toISOString()
  };
  vault.slots = [...(vault.slots || []), slot];
  writeVaultFile(vr, vault);
  return publicSlot(slot);
}

// The vault must be unlocked: a locked session cannot strip unlock methods.
function removeSlot(root, id) {
  const vr = findVaultRoot(root);
  const vault = vr && readVaultFile(vr);
  if (!vault) throw new Error('This folder is not encrypted');
  if (!keyForRoot(vr)) throw new LockedError(root);
  const before = (vault.slots || []).length;
  vault.slots = (vault.slots || []).filter(s => s.id !== id);
  if (vault.slots.length === before) return false;
  writeVaultFile(vr, vault);
  return true;
}

function unlockWithSlot(root, id, secret) {
  const vr = findVaultRoot(root);
  const vault = vr && readVaultFile(vr);
  if (!vault) throw new Error('This folder is not encrypted');
  const slot = (vault.slots || []).find(s => s.id === id);
  if (!slot) throw new Error('That unlock method was removed');
  const dataKey = unwrapWithKek(slot, slotKek(slot.type, secret, Buffer.from(slot.salt, 'base64')));
  if (!dataKey || (vault.keyId && vault.keyId !== keyId(dataKey))) throw new WrongKeyError();
  keys.set(norm(vr), dataKey);
  return { root: vr, dataKey };
}

// Unlock with a remembered data key. true on success; false when the key no
// longer matches the vault (folder was re-encrypted with a new key); null when
// vault.json cannot be read right now (partial sync, offline placeholder), in
// which case the key may still be good and must not be forgotten.
function unlockWithKey(root, dataKey) {
  const vr = findVaultRoot(root);
  const vault = vr && readVaultFile(vr);
  if (!vault) return null;
  if (!dataKey || dataKey.length !== KEY_LEN) return false;
  if (vault.keyId && vault.keyId !== keyId(dataKey)) return false;
  keys.set(norm(vr), dataKey);
  return true;
}

async function changePassword(root, oldPassword, newPassword) {
  checkPassword(newPassword);
  const vr = findVaultRoot(root);
  const vault = vr && readVaultFile(vr);
  if (!vault) throw new Error('This folder is not encrypted');
  const dataKey = await unwrapKey(vault, oldPassword);
  // Replace only the password fields; hardware slots stay enrolled.
  writeVaultFile(vr, { ...vault, ...(await wrapKey(dataKey, newPassword)) });
  keys.set(norm(vr), dataKey);
}

function lock(root) {
  const vr = findVaultRoot(root);
  if (vr) dropKey(vr);
}

// Removes vault.json. Only call once every file has been decrypted.
function removeVault(root) {
  const vr = findVaultRoot(root);
  if (!vr) return;
  if (migrating.has(norm(vr))) throw new BusyError(root);
  fs.unlinkSync(vaultFilePath(vr));
  dropKey(vr);
  invalidate();
}

// ---------------------------------------------------------------------------
// File I/O. Drop-in replacements for fs read/write on note-folder paths.

function decodeRead(p, buf, encoding) {
  let out = buf;
  if (isEncrypted(buf)) {
    const key = keyForRoot(vaultRootForFile(p));
    if (!key) throw new LockedError(p);
    out = decryptBuf(key, buf);
  }
  return encoding ? out.toString(encoding) : out;
}

// Plain bytes to write at p: encrypted when p is inside a vault. Writing into
// a locked vault throws rather than leaving plaintext behind. The vault lookup
// skips the cache: a vault.json that synced in since the last folder scan must
// not be missed, or the write would land in plaintext.
function encodeWrite(p, data, encoding) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), encoding || 'utf8');
  const vr = findVaultRoot(path.dirname(path.resolve(String(p))), true);
  if (!vr) return buf;
  if (migrating.has(norm(vr))) throw new BusyError(p);
  const foreign = readForeignLock(vr);
  if (foreign) throw new BusyError(p, foreign.host || 'another computer');
  const key = keyForRoot(vr);
  if (!key) throw new LockedError(p);
  return encryptBuf(key, buf);
}

async function readFile(p, encoding) {
  return decodeRead(p, await fsp.readFile(p), encoding);
}

function readFileSync(p, encoding) {
  return decodeRead(p, fs.readFileSync(p), encoding);
}

async function writeFile(p, data, encoding) {
  await fsp.writeFile(p, encodeWrite(p, data, encoding));
}

function writeFileSync(p, data, encoding) {
  fs.writeFileSync(p, encodeWrite(p, data, encoding));
}

// Like writeFileSync, but replaces the file in one step (temp + rename) so a
// reader on another computer never sees it half written. Not for .txt notes:
// replacing a file resets its creation time, which the calendar uses.
function writeFileAtomicSync(p, data, encoding) {
  replaceFileSync(p, encodeWrite(p, data, encoding));
}

// Copy src (any file, usually from outside the vault) to dest, encrypting it
// when dest is inside a vault.
function copyFileSync(src, dest) {
  if (!vaultRootForFile(dest)) { fs.copyFileSync(src, dest); return; }
  writeFileSync(dest, readFileSync(src));
}

function fileIsEncryptedSync(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const head = Buffer.alloc(MAGIC.length + IV_LEN + TAG_LEN);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return isEncrypted(head.subarray(0, n));
  } catch (_e) {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_e) {}
  }
}

// ---------------------------------------------------------------------------
// Session temp dir: plaintext copies for external tools (ffmpeg, whisper).
// Lives only while the app runs; stale dirs are wiped on the next start.

const SESSION_PREFIX = 'noatboat-session-';
let sessionDir = null;

function getSessionTmpDir() {
  if (!sessionDir) {
    sessionDir = path.join(os.tmpdir(), SESSION_PREFIX + process.pid);
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function cleanupSessionTmpDirs() {
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir()); } catch (_e) { return; }
  for (const name of entries) {
    if (!name.startsWith(SESSION_PREFIX)) continue;
    const pid = Number(name.slice(SESSION_PREFIX.length));
    if (pid === process.pid || (pid && pidAlive(pid))) continue;
    try { fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true }); } catch (_e) {}
  }
}

function removeSessionTmpDir() {
  if (!sessionDir) return;
  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_e) {}
  sessionDir = null;
}

// Run fn with a plaintext path for p. Plaintext files are passed through;
// encrypted ones are decrypted to a session temp file removed afterwards.
async function withPlainTemp(p, fn) {
  if (!fileIsEncryptedSync(p)) return fn(p);
  const tmp = path.join(getSessionTmpDir(), crypto.randomBytes(8).toString('hex') + path.extname(p));
  await fsp.writeFile(tmp, await readFile(p));
  try {
    return await fn(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_e) {}
  }
}

// ---------------------------------------------------------------------------
// Migration: encrypt or decrypt every file the app owns under root - .txt
// notes and everything inside .noatformat folders (except vault.json).
// Other files and hidden folders (.git, .dropbox...) are left alone.
//
// Each file is rewritten in place so its creation time survives (the calendar
// uses it), with mtime restored afterwards. A copy of the new bytes is written
// to <file>.<mtime>.noatvault-tmp first (via a .partial name, so the copy is
// complete whenever it exists) and removed once the in-place write succeeds;
// recoverInterrupted finishes rewrites a crash cut short. Safe to re-run:
// files already in the target state are skipped. While a migration runs,
// writes into the vault fail with VAULT_BUSY (see encodeWrite).

function listOwnedFiles(root) {
  const out = [];
  const walk = (dir, inSidecar) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === NOATFORMAT_DIR) walk(full, true);
        else if (!ent.name.startsWith('.')) walk(full, inSidecar);
      } else if (ent.isFile()) {
        if (ent.name.endsWith(MIGRATE_TMP_SUFFIX) || ent.name.endsWith(PARTIAL_SUFFIX) || ent.name.endsWith('.tmp')) continue;
        if (inSidecar && (ent.name === VAULT_FILE || ent.name === LOCK_FILE)) continue;
        if (inSidecar || /\.txt$/i.test(ent.name)) out.push(full);
      }
    }
  };
  walk(root, false);
  return out;
}

function migrateTmpPath(p, stats) {
  return `${p}.${Math.round(stats.mtimeMs)}${MIGRATE_TMP_SUFFIX}`;
}

async function rewriteInPlace(p, bytes, stats) {
  const tmp = migrateTmpPath(p, stats);
  const partial = tmp + PARTIAL_SUFFIX;
  await fsp.writeFile(partial, bytes);
  await fsp.rename(partial, tmp); // from here on a complete copy exists
  await fsp.writeFile(p, bytes);
  await fsp.utimes(p, stats.atime, stats.mtime);
  await fsp.unlink(tmp);
}

// Finish rewrites that a crash interrupted. <file>.<mtime>.noatvault-tmp holds
// the complete target bytes of <file>; restore them unless <file> was modified
// after the copy was made (then both are left for the user). Stray .partial
// copies are removed. Returns { restored: [paths], kept: [paths] }.
function recoverInterrupted(root) {
  const out = { restored: [], kept: [] };
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === NOATFORMAT_DIR || !ent.name.startsWith('.')) walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (ent.name.endsWith(MIGRATE_TMP_SUFFIX + PARTIAL_SUFFIX)) {
        try { fs.unlinkSync(full); } catch (_e) {}
        continue;
      }
      const m = MIGRATE_TMP_RE.exec(ent.name);
      if (!m) continue;
      const target = path.join(dir, m[1]);
      try {
        const tmpSt = fs.statSync(full);
        let targetSt = null;
        try { targetSt = fs.statSync(target); } catch (_e) {}
        // Edited after the copy was made (our own rewrite resets mtime to an
        // older value, so this only matches outside edits).
        if (targetSt && targetSt.mtimeMs > tmpSt.mtimeMs + 2000) { out.kept.push(target); continue; }
        fs.writeFileSync(target, fs.readFileSync(full));
        const t = new Date(Number(m[2]));
        fs.utimesSync(target, t, t);
        fs.unlinkSync(full);
        out.restored.push(target);
      } catch (_e) {
        out.kept.push(target);
      }
    }
  };
  walk(root);
  return out;
}

// opts.shouldSkip(stats) -> true to leave a file for later (online-only).
// opts.onProgress({ done, total, file }).
async function migrateFolder(root, mode, opts = {}) {
  if (mode !== 'encrypt' && mode !== 'decrypt') throw new Error('Bad mode');
  const vr = findVaultRoot(root);
  const key = keyForRoot(vr);
  if (!key) throw new LockedError(root);
  const nr = norm(vr);
  if (migrating.has(nr)) throw new BusyError(root);
  const foreign = readForeignLock(vr);
  if (foreign) throw new BusyError(root, foreign.host || 'another computer');
  migrating.add(nr);
  writeOwnLock(vr);
  const beat = setInterval(() => { try { writeOwnLock(vr); } catch (_e) {} }, LOCK_BEAT_MS);
  if (beat.unref) beat.unref();
  try {
    const recovered = recoverInterrupted(vr);
    const files = listOwnedFiles(vr);
    const result = { total: files.length, changed: 0, skipped: [], failed: [], recovered: recovered.restored.length };
    let done = 0;
    for (const p of files) {
      try {
        const stats = await fsp.stat(p);
        if (opts.shouldSkip && opts.shouldSkip(stats)) {
          result.skipped.push(p);
        } else {
          const buf = await fsp.readFile(p);
          const enc = isEncrypted(buf);
          if (mode === 'encrypt' && !enc) {
            await rewriteInPlace(p, encryptBuf(key, buf), stats);
            result.changed++;
          } else if (mode === 'decrypt' && enc) {
            await rewriteInPlace(p, decryptBuf(key, buf), stats);
            result.changed++;
          }
        }
      } catch (e) {
        result.failed.push({ path: p, error: String((e && e.message) || e) });
      }
      done++;
      if (opts.onProgress) opts.onProgress({ done, total: files.length, file: p });
    }
    return result;
  } finally {
    clearInterval(beat);
    removeOwnLock(vr);
    migrating.delete(nr);
  }
}

// Owned files under root that are still encrypted (after a decrypt run this
// must be empty before vault.json may go).
function listEncryptedFiles(root) {
  const vr = findVaultRoot(root);
  return vr ? listOwnedFiles(vr).filter(fileIsEncryptedSync) : [];
}

module.exports = {
  MAGIC,
  MIN_PASSWORD_LEN,
  LOCK_FILE,
  LockedError,
  WrongPasswordError,
  WrongKeyError,
  KeyMismatchError,
  BusyError,
  DuplicateKeyError,
  isEncrypted,
  encryptBuf,
  decryptBuf,
  deriveKek,
  keyId,
  readVaultFile,
  findVaultRoot,
  invalidate,
  status,
  createVault,
  unlockWithPassword,
  unlockWithKey,
  listSlots,
  getSlot,
  newSlotSalt,
  assertNotEnrolled,
  addSlot,
  removeSlot,
  unlockWithSlot,
  changePassword,
  lock,
  removeVault,
  readFile,
  readFileSync,
  writeFile,
  writeFileSync,
  writeFileAtomicSync,
  replaceFileSync,
  copyFileSync,
  fileIsEncryptedSync,
  getSessionTmpDir,
  cleanupSessionTmpDirs,
  removeSessionTmpDir,
  withPlainTemp,
  listOwnedFiles,
  listEncryptedFiles,
  recoverInterrupted,
  migrateFolder
};
