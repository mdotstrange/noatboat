const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vault = require('./vault');
const sync = require('./sync-engine');

// One network drive and any number of computers, each with its own local
// copy and manifest.
function world() {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'noatsync-test-'));
  const share = path.join(top, 'share');
  fs.mkdirSync(share);
  sync.initShare(share);
  const pcs = {};
  const pc = (id) => {
    if (!pcs[id]) {
      const local = path.join(top, `local-${id}`);
      fs.mkdirSync(local, { recursive: true });
      pcs[id] = {
        local,
        manifest: path.join(top, `manifest-${id}.json`),
        run: (extra) => sync.syncOnce({
          localRoot: local, shareRoot: share, manifestPath: path.join(top, `manifest-${id}.json`),
          machineId: id, hostName: `PC-${id}`, ...(extra || {})
        })
      };
    }
    return pcs[id];
  };
  return { top, share, pc };
}

function put(root, rel, data, mtime) {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  if (mtime) fs.utimesSync(p, mtime, mtime);
}

function get(root, rel) {
  const p = path.join(root, ...rel.split('/'));
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

// Every file under root (relative, '/'), minus .noatsync.
function list(root) {
  const out = [];
  const visit = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name !== '.noatsync') visit(path.join(dir, e.name), r); }
      else out.push(r);
    }
  };
  visit(root, '');
  return out.sort();
}

// Writes from "another computer" get a later date, like a real save would.
let clock = Date.now() - 3600 * 1000;
function later() {
  clock += 5000;
  return new Date(clock);
}

test('first pass copies the drive into an empty local folder, keeping dates', () => {
  const w = world();
  const old = new Date('2024-03-04T05:06:07Z');
  put(w.share, 'Shopping.txt', 'eggs', old);
  put(w.share, 'Sub/Deep.txt', 'deep');
  put(w.share, '.noatformat/Shopping.format.json', '{"spans":[]}');
  put(w.share, '.git/config', 'not ours');
  const a = w.pc('A');
  const r = a.run();
  assert.strictEqual(r.state, 'ok');
  assert.deepStrictEqual(list(a.local), ['.noatformat/Shopping.format.json', 'Shopping.txt', 'Sub/Deep.txt']);
  assert.strictEqual(Math.round(fs.statSync(path.join(a.local, 'Shopping.txt')).mtimeMs / 1000), Math.round(old.getTime() / 1000));
  const m = sync.loadManifest(a.manifest);
  assert.ok(m.created['shopping.txt'] > 0);
  // Nothing to do the second time.
  const r2 = a.run();
  assert.deepStrictEqual([r2.pulled, r2.pushed, r2.deleted, r2.conflicts], [[], [], [], []]);
});

test('edits, new files and deletions travel both ways', () => {
  const w = world();
  put(w.share, 'One.txt', 'one');
  put(w.share, 'Two.txt', 'two');
  put(w.share, 'Three.txt', 'three');
  const a = w.pc('A');
  a.run();

  put(a.local, 'One.txt', 'one edited here', later());
  put(w.share, 'Two.txt', 'two edited there', later());
  put(a.local, 'New here.txt', 'n1');
  put(w.share, 'New there.txt', 'n2');
  fs.unlinkSync(path.join(a.local, 'Three.txt'));
  const r = a.run();
  assert.strictEqual(r.state, 'ok');
  assert.deepStrictEqual(r.pushed.sort(), ['New here.txt', 'One.txt']);
  assert.deepStrictEqual(r.pulled.sort(), ['New there.txt', 'Two.txt']);
  assert.deepStrictEqual(r.deleted, ['Three.txt']);
  assert.strictEqual(get(w.share, 'One.txt'), 'one edited here');
  assert.strictEqual(get(a.local, 'Two.txt'), 'two edited there');
  assert.strictEqual(get(w.share, 'Three.txt'), null);
  // Deleted, not destroyed.
  const trash = path.join(w.share, '.noatsync', 'trash');
  const day = fs.readdirSync(trash)[0];
  assert.strictEqual(fs.readFileSync(path.join(trash, day, 'Three.txt'), 'utf8'), 'three');

  // Deleted on the drive (by the other computer): goes to the local trash.
  fs.unlinkSync(path.join(w.share, 'Two.txt'));
  const r2 = a.run();
  assert.deepStrictEqual(r2.deleted, ['Two.txt']);
  assert.strictEqual(get(a.local, 'Two.txt'), null);
  assert.ok(fs.existsSync(path.join(a.local, '.noatsync', 'trash')));
});

test('an edit beats a delete, in both directions', () => {
  const w = world();
  put(w.share, 'Kept here.txt', 'v1');
  put(w.share, 'Kept there.txt', 'v1');
  const a = w.pc('A');
  a.run();
  put(a.local, 'Kept here.txt', 'v2 local', later());
  fs.unlinkSync(path.join(w.share, 'Kept here.txt'));
  put(w.share, 'Kept there.txt', 'v2 share', later());
  fs.unlinkSync(path.join(a.local, 'Kept there.txt'));
  const r = a.run();
  assert.strictEqual(r.state, 'ok');
  assert.strictEqual(get(w.share, 'Kept here.txt'), 'v2 local');
  assert.strictEqual(get(a.local, 'Kept there.txt'), 'v2 share');
  assert.deepStrictEqual(r.deleted, []);
});

test('nothing is deleted without a manifest: both sides are merged', () => {
  const w = world();
  put(w.share, 'Only there.txt', 'x');
  const a = w.pc('A');
  put(a.local, 'Only here.txt', 'y');
  put(a.local, 'Both.txt', 'same');
  put(w.share, 'Both.txt', 'same');
  const r = a.run();
  assert.strictEqual(r.state, 'ok');
  assert.deepStrictEqual(list(a.local), ['Both.txt', 'Only here.txt', 'Only there.txt']);
  assert.deepStrictEqual(list(w.share), ['Both.txt', 'Only here.txt', 'Only there.txt']);
  assert.deepStrictEqual(r.conflicts, []);
});

test('a note changed on both computers keeps both versions', () => {
  const w = world();
  put(w.share, 'Plan.txt', 'base');
  const a = w.pc('A');
  const b = w.pc('B');
  a.run();
  b.run();
  put(b.local, 'Plan.txt', 'from B', later());
  b.run(); // B's version reaches the drive
  put(a.local, 'Plan.txt', 'from A', later());
  const r = a.run();
  assert.strictEqual(r.state, 'ok');
  assert.strictEqual(r.conflicts.length, 1);
  assert.match(r.conflicts[0], /^Plan \(conflict from PC-B \d{4}-\d{2}-\d{2} \d{4}\)\.txt$/);
  assert.strictEqual(get(a.local, 'Plan.txt'), 'from A');
  assert.strictEqual(get(w.share, 'Plan.txt'), 'from A');
  assert.strictEqual(get(a.local, r.conflicts[0]), 'from B');
  assert.strictEqual(get(w.share, r.conflicts[0]), 'from B');
  // B then gets both, with no further conflict.
  const rb = b.run();
  assert.deepStrictEqual(rb.conflicts, []);
  assert.strictEqual(get(b.local, 'Plan.txt'), 'from A');
  assert.strictEqual(get(b.local, r.conflicts[0]), 'from B');
  // And the pass after that is quiet.
  const again = a.run();
  assert.deepStrictEqual([again.pulled, again.pushed, again.conflicts], [[], [], []]);
});

test('a drawing changed on both computers becomes a conflict note with that drawing', () => {
  const w = world();
  put(w.share, 'Sketch.txt', 'words');
  put(w.share, '.noatformat/Sketch.canvas.json', '{"v":0}');
  const a = w.pc('A');
  a.run();
  put(a.local, '.noatformat/Sketch.canvas.json', '{"v":"A"}', later());
  put(w.share, '.noatformat/Sketch.canvas.json', '{"v":"other"}', later());
  const r = a.run();
  assert.strictEqual(r.conflicts.length, 1);
  const noteRel = r.conflicts[0];
  assert.match(noteRel, /^Sketch \(conflict from another computer .+\)\.txt$/);
  const cbase = noteRel.slice(0, -4);
  assert.strictEqual(get(a.local, noteRel), 'words');
  assert.strictEqual(get(a.local, `.noatformat/${cbase}.canvas.json`), '{"v":"other"}');
  assert.strictEqual(get(w.share, `.noatformat/${cbase}.canvas.json`), '{"v":"other"}');
  assert.strictEqual(get(a.local, '.noatformat/Sketch.canvas.json'), '{"v":"A"}');
});

test('another computer syncing holds this one off; a stale lock does not', () => {
  const w = world();
  put(w.share, 'N.txt', 'n');
  const a = w.pc('A');
  const lock = path.join(w.share, '.noatsync', 'sync.lock');
  fs.writeFileSync(lock, JSON.stringify({ machineId: 'B', host: 'PC-B', at: Date.now() }));
  const r = a.run();
  assert.strictEqual(r.state, 'busy');
  assert.strictEqual(r.busyHost, 'PC-B');
  assert.strictEqual(get(a.local, 'N.txt'), null);
  fs.writeFileSync(lock, JSON.stringify({ machineId: 'B', host: 'PC-B', at: Date.now() - 10 * 60 * 1000 }));
  assert.strictEqual(a.run().state, 'ok');
  assert.strictEqual(get(a.local, 'N.txt'), 'n');
  assert.ok(!fs.existsSync(lock), 'own lock removed after the pass');
});

test('an unreachable or unmarked drive is offline and changes nothing', () => {
  const w = world();
  const a = w.pc('A');
  put(a.local, 'Mine.txt', 'mine');
  const gone = sync.syncOnce({
    localRoot: a.local, shareRoot: path.join(w.top, 'nope'), manifestPath: a.manifest, machineId: 'A'
  });
  assert.strictEqual(gone.state, 'offline');
  // A mount point that exists but is not the synced folder (drive not mounted).
  const empty = path.join(w.top, 'empty-mount');
  fs.mkdirSync(empty);
  const r = sync.syncOnce({ localRoot: a.local, shareRoot: empty, manifestPath: a.manifest, machineId: 'A' });
  assert.strictEqual(r.state, 'offline');
  assert.deepStrictEqual(fs.readdirSync(empty), []);
  assert.strictEqual(get(a.local, 'Mine.txt'), 'mine');
});

test('Mac and Windows spellings of the same name are one file', () => {
  const w = world();
  const nfc = 'Café notes.txt'.normalize('NFC');
  const nfd = 'CAFÉ NOTES.txt'.normalize('NFD');
  const a = w.pc('A');
  put(a.local, nfc, 'same');
  put(w.share, nfd, 'same');
  const r = a.run();
  assert.strictEqual(r.state, 'ok');
  assert.deepStrictEqual([r.pulled, r.pushed, r.conflicts], [[], [], []]);
  assert.strictEqual(list(a.local).length, 1);
  // An edit on the drive under the other spelling lands on the local file.
  put(w.share, nfd, 'changed', later());
  const r2 = a.run();
  assert.deepStrictEqual(r2.pulled, [nfc]);
  assert.strictEqual(get(a.local, nfc), 'changed');
});

test('a pass that would empty one side stops instead', () => {
  const w = world();
  for (let i = 0; i < 30; i++) put(w.share, `n${i}.txt`, `note ${i}`);
  const a = w.pc('A');
  a.run();
  for (let i = 0; i < 30; i++) fs.unlinkSync(path.join(w.share, `n${i}.txt`));
  const r = a.run();
  assert.strictEqual(r.state, 'error');
  assert.ok(r.massDelete);
  assert.strictEqual(list(a.local).length, 30);
});

test('encrypted files are copied byte for byte', () => {
  const w = world();
  const key = crypto.randomBytes(32);
  const enc = vault.encryptBuf(key, Buffer.from('secret'));
  put(w.share, 'Secret.txt', enc);
  put(w.share, '.noatformat/Secret.png', crypto.randomBytes(3000));
  const a = w.pc('A');
  a.run();
  const got = fs.readFileSync(path.join(a.local, 'Secret.txt'));
  assert.ok(got.equals(enc));
  assert.strictEqual(vault.decryptBuf(key, got).toString(), 'secret');
  assert.ok(fs.readFileSync(path.join(a.local, '.noatformat/Secret.png')).equals(fs.readFileSync(path.join(w.share, '.noatformat/Secret.png'))));
});

test('no temp files are left behind, and temp files are never synced', () => {
  const w = world();
  put(w.share, 'A.txt', 'a');
  put(w.share, 'B.txt.1a2b3c4d.tmp', 'half a write');
  put(w.share, '.noatformat/vault.lock', '{}');
  const a = w.pc('A');
  a.run();
  put(a.local, 'A.txt', 'a2', later());
  a.run();
  assert.deepStrictEqual(list(a.local), ['A.txt']);
  assert.deepStrictEqual(list(w.share), ['.noatformat/vault.lock', 'A.txt', 'B.txt.1a2b3c4d.tmp']);
});

test('creation dates: the earliest date any computer recorded wins', () => {
  const w = world();
  put(w.share, 'Old.txt', 'old');
  const a = w.pc('A');
  a.run();
  const early = Date.UTC(2020, 0, 2);
  fs.mkdirSync(path.join(w.share, '.noatsync', 'machines'), { recursive: true });
  fs.writeFileSync(path.join(w.share, '.noatsync', 'machines', 'B.json'),
    JSON.stringify({ machineId: 'B', host: 'PC-B', created: { 'old.txt': early } }));
  a.run();
  assert.strictEqual(sync.loadManifest(a.manifest).created['old.txt'], early);
  const mine = JSON.parse(fs.readFileSync(path.join(w.share, '.noatsync', 'machines', 'A.json'), 'utf8'));
  assert.strictEqual(mine.created['old.txt'], early);
});

test('a pass cut off halfway finishes on the next one', () => {
  const w = world();
  for (let i = 0; i < 60; i++) put(w.share, `n${i}.txt`, `note ${i}`);
  const a = w.pc('A');
  const r = a.run({ onProgress: (p) => { if (p.phase === 'copy' && p.done >= 30) throw new Error('network dropped'); } });
  assert.strictEqual(r.state, 'error');
  const halfway = list(a.local).length;
  assert.ok(halfway >= 29 && halfway < 60, `copied ${halfway} before the drop`);
  const r2 = a.run();
  assert.strictEqual(r2.state, 'ok');
  assert.strictEqual(r2.pulled.length, 60 - halfway, 'only the rest is copied');
  assert.strictEqual(list(a.local).length, 60);
});

test('folders: new ones appear on the other side, deleted empty ones go', () => {
  const w = world();
  const a = w.pc('A');
  fs.mkdirSync(path.join(w.share, 'Projects'));
  fs.mkdirSync(path.join(a.local, 'Ideas'));
  a.run();
  assert.ok(fs.existsSync(path.join(a.local, 'Projects')));
  assert.ok(fs.existsSync(path.join(w.share, 'Ideas')));
  fs.rmdirSync(path.join(a.local, 'Ideas'));
  fs.writeFileSync(path.join(w.share, 'Ideas', '.DS_Store'), 'finder');
  a.run();
  assert.ok(!fs.existsSync(path.join(w.share, 'Ideas')));
});

test('a local folder must be empty or already this share\'s copy', () => {
  const w = world();
  const a = w.pc('A');
  assert.ok(sync.checkLocalFolder(a.local, w.share).ok);
  put(a.local, 'stray.txt', 'x');
  assert.ok(!sync.checkLocalFolder(a.local, w.share).ok);
  sync.initLocal(a.local, w.share);
  assert.ok(sync.checkLocalFolder(a.local, w.share).existing);
});
