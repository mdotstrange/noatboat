// Sync between this computer's copy of a notes folder and the shared copy on a
// network drive. The app only ever reads and writes the local copy; a sync
// pass brings the two in step whenever the drive is reachable.
//
// Each file is compared three ways: local, network drive, and the version both
// had after the last pass (the manifest, kept per computer in userData). That
// tells "changed here" from "changed there" and "deleted there" from "new
// here", without trusting either computer's clock.
//
// Files are copied byte for byte: encrypted notes stay encrypted and are never
// decrypted here. Nothing is deleted outright; deletions go to
// .noatsync/trash/<date>/ on the side they happen to.
//
// On the network drive, .noatsync/ holds:
//   share.json            marks the folder as set up for sync
//   sync.lock             the computer syncing right now (stale after 2 min)
//   machines/<id>.json    per computer: note creation dates, what it pushed
// Each computer only ever writes its own machines/ file.
//
// No Electron imports: sync-host.js runs this in its own process (a stuck
// network drive must not freeze the app) and the tests run it under node.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vault = require('./vault');
const { NOATFORMAT_DIR, SYNC_DIR, skipDir, syncSkipFile } = require('./syncignore');

const SHARE_MARK = 'share.json';
const LOCAL_MARK = 'local.json';
const LOCK_FILE = 'sync.lock';
const MACHINES_DIR = 'machines';
const TRASH_DIR = 'trash';
const LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_BEAT_MS = 30 * 1000;
const SAVE_EVERY = 50;
const TRASH_KEEP_DAYS = 30;
// A pass that would delete more than this many files on one side stops and
// asks for a look instead (a drive mounted empty, a wiped local folder).
const MASS_DELETE_MIN = 20;
const MASS_DELETE_FRACTION = 0.5;
const SIDECAR_SUFFIXES = ['.canvas.json', '.canvas.png', '.format.json'];

// Paths are matched case-insensitively and in one Unicode form: both Windows
// and macOS ignore case, and macOS hands out accented names decomposed (NFD).
function keyOf(rel) {
  return String(rel).normalize('NFC').toLowerCase();
}

function toAbs(root, rel) {
  return path.join(root, ...rel.split('/'));
}

// "a/b.txt" for p under root, or null.
function relOf(root, p) {
  const r = path.relative(path.resolve(root), path.resolve(p));
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
  return r.split(path.sep).join('/');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function statOrNull(p) {
  try { return fs.statSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function sameStat(a, b) {
  return !!(a && b && a.size === b.size && a.mtimeMs === b.mtimeMs);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function dayStamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  vault.replaceFileSync(p, JSON.stringify(obj));
}

function readJsonOrNull(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_e) { return null; }
}

// ---------------------------------------------------------------------------
// Listing

// Every synced file and folder under root, keyed by keyOf(rel). A folder that
// cannot be listed throws: a half-listed side would look like deletions.
// tick() is called every so often, to show a big folder is still moving.
function walk(root, tick) {
  const out = new Map();
  let seen = 0;
  const visit = (dir, rel, parentName) => {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of items) {
      if (tick && ++seen % 200 === 0) tick();
      if (ent.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const full = path.join(dir, ent.name);
      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      let st = null;
      if (!isDir && !isFile) { // some network filesystems report no type
        st = fs.lstatSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      }
      const key = keyOf(childRel);
      if (out.has(key)) continue; // same name twice on a case-sensitive disk
      if (isDir) {
        if (skipDir(ent.name)) continue;
        out.set(key, { rel: childRel, dir: true });
        visit(full, childRel, ent.name);
      } else if (isFile) {
        if (syncSkipFile(ent.name, parentName)) continue;
        st = st || fs.statSync(full);
        out.set(key, { rel: childRel, size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs });
      }
    }
  };
  visit(root, '', '');
  return out;
}

// ---------------------------------------------------------------------------
// Manifest (this computer's record of the last pass)

function emptyManifest() {
  return { version: 1, lastSynced: 0, entries: {}, created: {}, pushed: {} };
}

function loadManifest(p) {
  const m = readJsonOrNull(p);
  if (!m || typeof m !== 'object' || !m.entries) return emptyManifest();
  m.created = m.created || {};
  m.pushed = m.pushed || {};
  return m;
}

function saveManifest(p, m) {
  writeJson(p, m);
}

// ---------------------------------------------------------------------------
// Markers, lock, per-computer metadata

function sharePaths(shareRoot) {
  const dir = path.join(shareRoot, SYNC_DIR);
  return { dir, mark: path.join(dir, SHARE_MARK), lock: path.join(dir, LOCK_FILE), machines: path.join(dir, MACHINES_DIR) };
}

function initShare(shareRoot) {
  const p = sharePaths(shareRoot);
  if (!fs.existsSync(p.mark)) writeJson(p.mark, { createdAt: Date.now() });
}

function shareIsInitialised(shareRoot) {
  return fs.existsSync(sharePaths(shareRoot).mark);
}

// A local folder may be used when it is empty or is already this share's copy.
function checkLocalFolder(localRoot, shareRoot) {
  let items;
  try { items = fs.readdirSync(localRoot); } catch (e) {
    if (e.code === 'ENOENT') return { ok: true };
    return { ok: false, error: e.message };
  }
  const mark = readJsonOrNull(path.join(localRoot, SYNC_DIR, LOCAL_MARK));
  if (mark && mark.shareRoot && keyOf(path.resolve(mark.shareRoot)) === keyOf(path.resolve(shareRoot))) return { ok: true, existing: true };
  if (items.filter(n => n !== '.DS_Store' && n.toLowerCase() !== 'desktop.ini').length === 0) return { ok: true };
  return { ok: false, error: 'Choose an empty folder (this one already has files in it).' };
}

function initLocal(localRoot, shareRoot) {
  writeJson(path.join(localRoot, SYNC_DIR, LOCAL_MARK), { shareRoot: path.resolve(shareRoot) });
}

// The lock of another computer that is still being refreshed, or null. The
// time check allows for clocks a little apart in either direction.
function foreignLock(shareRoot, machineId) {
  const l = readJsonOrNull(sharePaths(shareRoot).lock);
  if (!l || l.machineId === machineId) return null;
  if (!(Math.abs(Date.now() - Number(l.at)) < LOCK_STALE_MS)) return null;
  return l;
}

function writeLock(shareRoot, machineId, host) {
  writeJson(sharePaths(shareRoot).lock, { machineId, host, at: Date.now() });
}

function removeLock(shareRoot, machineId) {
  const p = sharePaths(shareRoot).lock;
  const l = readJsonOrNull(p);
  if (l && l.machineId === machineId) { try { fs.unlinkSync(p); } catch (_e) {} }
}

function readMachines(shareRoot) {
  const dir = sharePaths(shareRoot).machines;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_e) { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const m = readJsonOrNull(path.join(dir, n));
    if (m && m.machineId) out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// File operations

// Copy src over dst (temp file + rename) keeping src's modified time.
// Returns the hash of the bytes copied and both sides' stats afterwards.
function copyFile(srcAbs, dstAbs) {
  const st = fs.statSync(srcAbs);
  const bytes = fs.readFileSync(srcAbs);
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  vault.replaceFileSync(dstAbs, bytes);
  try { fs.utimesSync(dstAbs, st.atime, st.mtime); } catch (_e) {}
  const dst = fs.statSync(dstAbs);
  return {
    hash: sha256(bytes),
    src: { size: st.size, mtimeMs: st.mtimeMs },
    dst: { size: dst.size, mtimeMs: dst.mtimeMs }
  };
}

// Move root/rel into root/.noatsync/trash/<today>/rel.
function moveToTrash(root, rel, now) {
  const src = toAbs(root, rel);
  let dst = toAbs(path.join(root, SYNC_DIR, TRASH_DIR, dayStamp(now)), rel);
  const ext = path.extname(dst);
  const stem = dst.slice(0, dst.length - ext.length);
  for (let i = 2; fs.existsSync(dst); i++) dst = `${stem} (${i})${ext}`;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
}

function cleanTrash(root, now) {
  const dir = path.join(root, SYNC_DIR, TRASH_DIR);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_e) { return; }
  const cutoff = now.getTime() - TRASH_KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const n of names) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(n);
    if (!m) continue;
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (t < cutoff) { try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch (_e) {} }
  }
}

// Remove dir when nothing but system clutter (.DS_Store, Thumbs.db) is in it.
function removeEmptyDir(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return e.code === 'ENOENT'; }
  const junk = (n) => { const l = n.toLowerCase(); return l === '.ds_store' || l === 'thumbs.db' || l === 'desktop.ini' || n.startsWith('._'); };
  if (!names.every(junk)) return false;
  try {
    for (const n of names) fs.unlinkSync(path.join(dir, n));
    fs.rmdirSync(dir);
    return true;
  } catch (_e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Conflict copies

// "Shopping.canvas.json" in .noatformat -> ["Shopping", ".canvas.json"].
function splitName(name, inSidecarDir) {
  if (inSidecarDir) {
    const lower = name.toLowerCase();
    for (const s of SIDECAR_SUFFIXES) {
      if (lower.endsWith(s)) return [name.slice(0, -s.length), name.slice(-s.length)];
    }
  }
  const ext = path.posix.extname(name);
  return [name.slice(0, name.length - ext.length), ext];
}

// Which note a file belongs to: { noteDir, base, sidecar }. A note's
// attachments live in <noteDir>/.noatformat/<base><suffix>.
function noteOf(rel) {
  const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
  const name = path.posix.basename(rel);
  const sidecar = path.posix.basename(dir) === NOATFORMAT_DIR;
  const [base, suffix] = splitName(name, sidecar);
  const noteDir = sidecar ? (path.posix.dirname(dir) === '.' ? '' : path.posix.dirname(dir)) : dir;
  return { dir, name, base, suffix, noteDir, sidecar };
}

function joinRel(...parts) {
  return parts.filter(Boolean).join('/');
}

function conflictStamp(d) {
  return `${dayStamp(d)} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function safeName(s) {
  return String(s || 'another computer').replace(/[\\/:*?"<>|]/g, '_');
}

// ---------------------------------------------------------------------------
// One pass

class SyncAbort extends Error {
  constructor(state, message, extra) {
    super(message);
    this.state = state;
    Object.assign(this, extra || {});
  }
}

// opts: { localRoot, shareRoot, manifestPath, machineId, hostName,
//         onProgress?(p), now?() }
// Returns { state: 'ok'|'offline'|'busy'|'error', lastSynced, pulled, pushed,
//           deleted, conflicts, pending, errors, error? }
function syncOnce(opts) {
  const { localRoot, shareRoot, manifestPath, machineId } = opts;
  const hostName = opts.hostName || 'this computer';
  const onProgress = opts.onProgress || (() => {});
  const nowDate = () => (opts.now ? opts.now() : new Date());
  const manifest = loadManifest(manifestPath);
  const result = {
    state: 'ok', lastSynced: manifest.lastSynced || 0,
    pulled: [], pushed: [], deleted: [], conflicts: [], pending: [], errors: []
  };

  try {
    fs.statSync(shareRoot);
  } catch (e) {
    return { ...result, state: 'offline', error: e.message };
  }
  if (!shareIsInitialised(shareRoot)) {
    // Mounted, but not the folder that was set up (or an empty mount point).
    return { ...result, state: 'offline', error: 'The network folder is not the synced notes folder' };
  }
  if (!fs.existsSync(localRoot)) {
    return { ...result, state: 'error', error: `The local copy is missing: ${localRoot}` };
  }

  const other = foreignLock(shareRoot, machineId);
  if (other) return { ...result, state: 'busy', busyHost: other.host || 'another computer' };
  writeLock(shareRoot, machineId, hostName);
  let lastBeat = Date.now();
  const beat = () => {
    if (Date.now() - lastBeat < LOCK_BEAT_MS) return;
    writeLock(shareRoot, machineId, hostName);
    lastBeat = Date.now();
  };

  let sinceSave = 0;
  const touched = () => {
    beat();
    if (++sinceSave >= SAVE_EVERY) { saveManifest(manifestPath, manifest); sinceSave = 0; }
  };

  try {
    const scanTick = () => { onProgress({ phase: 'scan' }); beat(); };
    scanTick();
    const L = walk(localRoot, scanTick);
    scanTick();
    const R = walk(shareRoot, scanTick);
    beat();

    const machines = readMachines(shareRoot);
    // Creation dates: the earliest any computer recorded.
    for (const m of machines) {
      for (const [k, t] of Object.entries(m.created || {})) {
        if (t > 0 && !(manifest.created[k] <= t)) manifest.created[k] = t;
      }
    }

    const base = manifest.entries;
    const keys = new Set([...L.keys(), ...R.keys(), ...Object.keys(base)]);
    const fileKeys = [];
    const dirKeys = [];
    for (const k of keys) {
      const isDir = (L.get(k) || R.get(k) || base[k]).dir;
      (isDir ? dirKeys : fileKeys).push(k);
    }

    // --- Decide ---
    const hashOf = (root, cur, b, side) => {
      if (!cur) return null;
      if (b && b.hash && sameStat(cur, b[side])) return b.hash;
      return sha256(fs.readFileSync(toAbs(root, cur.rel)));
    };
    const plan = [];
    let done = 0;
    for (const k of fileKeys) {
      const l = L.get(k), r = R.get(k), b = base[k] && !base[k].dir ? base[k] : null;
      if ((l && l.dir) || (r && r.dir)) {
        result.errors.push({ rel: (l || r).rel, error: 'A file on one side is a folder on the other' });
        continue;
      }
      if (++done % 25 === 0) { onProgress({ phase: 'compare', done, total: fileKeys.length }); beat(); }
      let lh, rh;
      try {
        lh = hashOf(localRoot, l, b, 'l');
        rh = hashOf(shareRoot, r, b, 'r');
      } catch (e) {
        if (e.code === 'ENOENT') { result.pending.push((l || r).rel); continue; } // changing right now
        throw e;
      }
      let op = null;
      if (l && r) {
        if (lh === rh) op = 'same';
        else if (b && lh === b.hash) op = 'pull';
        else if (b && rh === b.hash) op = 'push';
        else op = 'conflict';
      } else if (l) {
        op = (b && lh === b.hash) ? 'delete-local' : 'push';
      } else if (r) {
        op = (b && rh === b.hash) ? 'delete-remote' : 'pull';
      } else {
        op = 'forget';
      }
      plan.push({ k, l, r, b, lh, rh, op });
    }

    // Refuse passes that would empty one side.
    const baseFiles = Object.values(base).filter(e => !e.dir).length;
    const limit = Math.max(MASS_DELETE_MIN, Math.floor(baseFiles * MASS_DELETE_FRACTION));
    const delLocal = plan.filter(p => p.op === 'delete-local').length;
    const delRemote = plan.filter(p => p.op === 'delete-remote').length;
    if (delLocal > limit || delRemote > limit) {
      const where = delLocal > limit ? 'this computer' : 'the network drive';
      throw new SyncAbort('error', `Sync stopped: it would delete ${Math.max(delLocal, delRemote)} files on ${where}. Check that both folders are the right ones.`, { massDelete: true });
    }

    // --- Act ---
    const now = nowDate();
    const localAbs = (rel) => toAbs(localRoot, rel);
    const shareAbs = (rel) => toAbs(shareRoot, rel);
    // A side changed since it was listed (an autosave just landed): leave
    // that file for the next pass.
    const unchanged = (abs, seen) => {
      const st = statOrNull(abs);
      return seen ? sameStat(st, seen) : !st;
    };
    const record = (k, rel, c, pushedHere) => {
      base[k] = { rel, hash: c.hash, l: c.l, r: c.r };
      if (pushedHere) manifest.pushed[k] = c.hash;
      touched();
    };
    const pull = (p) => {
      const rel = p.r.rel;
      const dst = localAbs(p.l ? p.l.rel : rel);
      if (!unchanged(dst, p.l)) { result.pending.push(rel); return; }
      const c = copyFile(shareAbs(rel), dst);
      record(p.k, p.l ? p.l.rel : rel, { hash: c.hash, r: c.src, l: c.dst }, false);
      result.pulled.push(p.l ? p.l.rel : rel);
    };
    const push = (p) => {
      const rel = p.l.rel;
      const dst = shareAbs(p.r ? p.r.rel : rel);
      if (!unchanged(dst, p.r)) { result.pending.push(rel); return; }
      const c = copyFile(localAbs(rel), dst);
      record(p.k, rel, { hash: c.hash, l: c.src, r: c.dst }, true);
      result.pushed.push(rel);
    };

    const conflicts = [];
    let acted = 0;
    for (const p of plan) {
      if (p.op !== 'same' && p.op !== 'forget' && ++acted % 10 === 0) onProgress({ phase: 'copy', done: acted, total: plan.length });
      try {
        switch (p.op) {
          case 'same':
            base[p.k] = { rel: p.l.rel, hash: p.lh, l: { size: p.l.size, mtimeMs: p.l.mtimeMs }, r: { size: p.r.size, mtimeMs: p.r.mtimeMs } };
            break;
          case 'pull': pull(p); break;
          case 'push': push(p); break;
          case 'delete-local':
            if (!unchanged(localAbs(p.l.rel), p.l)) { result.pending.push(p.l.rel); break; }
            moveToTrash(localRoot, p.l.rel, now);
            delete base[p.k];
            delete manifest.pushed[p.k];
            result.deleted.push(p.l.rel);
            touched();
            break;
          case 'delete-remote':
            if (!unchanged(shareAbs(p.r.rel), p.r)) { result.pending.push(p.r.rel); break; }
            moveToTrash(shareRoot, p.r.rel, now);
            delete base[p.k];
            delete manifest.pushed[p.k];
            result.deleted.push(p.r.rel);
            touched();
            break;
          case 'forget':
            delete base[p.k];
            delete manifest.pushed[p.k];
            break;
          case 'conflict':
            conflicts.push(p);
            break;
        }
      } catch (e) {
        result.errors.push({ rel: (p.l || p.r || p.b).rel, error: e.message });
        try { fs.statSync(shareRoot); } catch (_e) { throw new SyncAbort('offline', 'The network drive went away during sync'); }
      }
    }

    // Conflicts: keep this computer's version in place; the drive's version
    // becomes a "(conflict from <computer> <time>)" note next to it, with the
    // attachments that conflicted, so a drawing stays with its text.
    if (conflicts.length) {
      const groups = new Map();
      for (const p of conflicts) {
        const n = noteOf(p.l.rel);
        const gk = keyOf(joinRel(n.noteDir, n.sidecar || n.suffix.toLowerCase() === '.txt' ? n.base : n.name));
        if (!groups.has(gk)) groups.set(gk, []);
        groups.get(gk).push({ p, n });
      }
      const exists = (rel) => L.has(keyOf(rel)) || R.has(keyOf(rel)) || fs.existsSync(localAbs(rel)) || fs.existsSync(shareAbs(rel));
      for (const items of groups.values()) {
        try {
          const first = items[0];
          const author = machines.find(m => m.machineId !== machineId && m.pushed && m.pushed[first.p.k] === first.p.rh);
          const label = `conflict from ${safeName(author ? author.host : 'another computer')} ${conflictStamp(now)}`;
          const noteLike = items.some(it => it.n.sidecar || it.n.suffix.toLowerCase() === '.txt');
          const relFor = (n, cbase) => joinRel(n.dir, cbase + n.suffix);
          let cbase = `${first.n.base} (${label})`;
          for (let i = 2; items.some(it => exists(relFor(it.n, cbase))) || (noteLike && exists(joinRel(first.n.noteDir, cbase + '.txt'))); i++) {
            cbase = `${first.n.base} (${label} ${i})`;
          }
          for (const { p, n } of items) {
            if (!unchanged(shareAbs(p.r.rel), p.r) || !unchanged(localAbs(p.l.rel), p.l)) { result.pending.push(p.l.rel); continue; }
            const crel = relFor(n, cbase);
            // The drive's version, as a new file on both sides.
            const c1 = copyFile(shareAbs(p.r.rel), localAbs(crel));
            const c2 = copyFile(localAbs(crel), shareAbs(crel));
            record(keyOf(crel), crel, { hash: c1.hash, l: c1.dst, r: c2.dst }, false);
            // This computer's version wins the original name.
            const c3 = copyFile(localAbs(p.l.rel), shareAbs(p.r.rel));
            record(p.k, p.l.rel, { hash: c3.hash, l: c3.src, r: c3.dst }, true);
            result.conflicts.push(n.sidecar ? joinRel(n.noteDir, cbase + '.txt') : crel);
          }
          // Only attachments conflicted: give them a note to belong to,
          // with the drive's text of that note.
          const anyTxt = items.some(it => !it.n.sidecar && it.n.suffix.toLowerCase() === '.txt');
          if (noteLike && !anyTxt) {
            const nrel = joinRel(first.n.noteDir, first.n.base + '.txt');
            const crel = joinRel(first.n.noteDir, cbase + '.txt');
            const src = fs.existsSync(shareAbs(nrel)) ? shareAbs(nrel) : (fs.existsSync(localAbs(nrel)) ? localAbs(nrel) : null);
            if (src && !exists(crel)) {
              const c1 = copyFile(src, localAbs(crel));
              const c2 = copyFile(localAbs(crel), shareAbs(crel));
              record(keyOf(crel), crel, { hash: c1.hash, l: c1.dst, r: c2.dst }, false);
            }
          }
        } catch (e) {
          result.errors.push({ rel: items[0].p.l.rel, error: e.message });
          try { fs.statSync(shareRoot); } catch (_e) { throw new SyncAbort('offline', 'The network drive went away during sync'); }
        }
      }
      result.conflicts = [...new Set(result.conflicts)];
    }

    // --- Folders: create where missing; remove where deleted (deepest
    // first, and only when empty). ---
    dirKeys.sort((a, b) => b.length - a.length);
    for (const k of dirKeys) {
      const l = L.get(k), r = R.get(k), b = base[k] && base[k].dir ? base[k] : null;
      try {
        if (l && r) {
          base[k] = { rel: l.rel, dir: true };
        } else if (l || r) {
          const rel = (l || r).rel;
          const [here, there] = l ? [localAbs(rel), shareAbs(rel)] : [shareAbs(rel), localAbs(rel)];
          let removed = false;
          if (b) {
            removed = removeEmptyDir(here); // not empty: it has new files
          }
          if (removed) delete base[k];
          else {
            fs.mkdirSync(there, { recursive: true });
            base[k] = { rel, dir: true };
          }
        } else {
          delete base[k];
        }
      } catch (e) {
        result.errors.push({ rel: (l || r || b).rel, error: e.message });
      }
    }

    // --- Creation dates for notes: keep what any computer recorded; new
    // notes take the earliest file date seen on either side. ---
    for (const k of Object.keys(manifest.created)) {
      if (!base[k]) delete manifest.created[k];
    }
    for (const [k, e] of Object.entries(base)) {
      if (e.dir || !k.endsWith('.txt') || manifest.created[k] > 0) continue;
      const times = [L.get(k), R.get(k)].filter(Boolean).map(s => s.birthtimeMs).filter(t => t > 0);
      if (!times.length) {
        const st = statOrNull(localAbs(e.rel));
        if (st && st.birthtimeMs > 0) times.push(st.birthtimeMs);
      }
      if (times.length) manifest.created[k] = Math.min(...times);
    }
    for (const k of Object.keys(manifest.pushed)) {
      if (!base[k]) delete manifest.pushed[k];
    }

    manifest.lastSynced = now.getTime();
    saveManifest(manifestPath, manifest);
    sinceSave = 0;

    // This computer's line on the drive (only rewritten when it changed).
    const meta = { machineId, host: hostName, created: manifest.created, pushed: manifest.pushed };
    const metaPath = path.join(sharePaths(shareRoot).machines, `${machineId}.json`);
    const old = readJsonOrNull(metaPath);
    if (!old || JSON.stringify({ ...old, at: undefined }) !== JSON.stringify({ ...meta, at: undefined })) {
      writeJson(metaPath, { ...meta, at: now.getTime() });
    }

    cleanTrash(localRoot, now);
    cleanTrash(shareRoot, now);

    result.lastSynced = manifest.lastSynced;
    result.pending = [...new Set(result.pending)];
    return result;
  } catch (e) {
    if (sinceSave) { try { saveManifest(manifestPath, manifest); } catch (_e) {} }
    if (e instanceof SyncAbort) return { ...result, state: e.state, error: e.message, massDelete: e.massDelete || undefined };
    let offline = false;
    try { fs.statSync(shareRoot); } catch (_e) { offline = true; }
    return { ...result, state: offline ? 'offline' : 'error', error: e.message };
  } finally {
    removeLock(shareRoot, machineId);
  }
}

module.exports = {
  SYNC_DIR,
  keyOf,
  relOf,
  walk,
  loadManifest,
  initShare,
  initLocal,
  shareIsInitialised,
  checkLocalFolder,
  syncOnce
};
