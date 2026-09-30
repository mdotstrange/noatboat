const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vault = require('./vault');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'noatvault-test-'));
}

function makeTree(root) {
  const files = {
    'Shopping.txt': 'eggs\nmilk\n',
    'Sub/Deep note.txt': 'secret words',
    '.noatformat/Shopping.format.json': JSON.stringify({ spans: [], dueDate: '2026-10-01' }),
    '.noatformat/Shopping.png': crypto.randomBytes(2048),
    '.noatformat/calendar/2026-10-01.png': crypto.randomBytes(512),
    'Sub/.noatformat/Deep note.mp3': crypto.randomBytes(4096),
    'unrelated.pdf': 'not ours',
    '.git/config': 'not ours either'
  };
  for (const [rel, data] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  }
  return files;
}

test('encrypt/decrypt round-trip and tamper detection', () => {
  const key = crypto.randomBytes(32);
  const plain = Buffer.from('hello noat boat');
  const enc = vault.encryptBuf(key, plain);
  assert.ok(vault.isEncrypted(enc));
  assert.ok(!vault.isEncrypted(plain));
  assert.deepStrictEqual(vault.decryptBuf(key, enc), plain);

  const bad = Buffer.from(enc);
  bad[bad.length - 20] ^= 1;
  assert.throws(() => vault.decryptBuf(key, bad));
  assert.throws(() => vault.decryptBuf(crypto.randomBytes(32), enc));
});

test('vault lifecycle: create, lock, wrong password, unlock, change password', async () => {
  const root = tempRoot();
  const note = path.join(root, 'a.txt');
  await vault.createVault(root, 'correct horse');
  await vault.writeFile(note, 'top secret', 'utf8');
  assert.ok(vault.isEncrypted(fs.readFileSync(note)));
  assert.strictEqual(await vault.readFile(note, 'utf8'), 'top secret');
  assert.strictEqual(vault.status(root).state, 'unlocked');

  vault.lock(root);
  assert.strictEqual(vault.status(root).state, 'locked');
  await assert.rejects(vault.readFile(note, 'utf8'), { code: 'VAULT_LOCKED' });
  assert.throws(() => vault.writeFileSync(path.join(root, 'b.txt'), 'x'), { code: 'VAULT_LOCKED' });
  assert.ok(!fs.existsSync(path.join(root, 'b.txt')));

  await assert.rejects(vault.unlockWithPassword(root, 'wrong'), { code: 'VAULT_WRONG_PASSWORD' });
  const dataKey = Buffer.from((await vault.unlockWithPassword(root, 'correct horse')).dataKey); // lock() zeroes the original

  await vault.changePassword(root, 'correct horse', 'battery staple');
  vault.lock(root);
  await assert.rejects(vault.unlockWithPassword(root, 'correct horse'), { code: 'VAULT_WRONG_PASSWORD' });
  await vault.unlockWithPassword(root, 'battery staple');
  assert.strictEqual(await vault.readFile(note, 'utf8'), 'top secret');

  // Remembered key still matches after a password change; a random one doesn't.
  vault.lock(root);
  assert.strictEqual(vault.unlockWithKey(root, crypto.randomBytes(32)), false);
  assert.strictEqual(vault.unlockWithKey(root, dataKey), true);
  assert.strictEqual(vault.readFileSync(note, 'utf8'), 'top secret');

  // Subfolders are covered by the root's vault.
  const sub = path.join(root, 'Sub');
  fs.mkdirSync(sub);
  vault.writeFileSync(path.join(sub, 'c.txt'), 'nested');
  assert.ok(vault.isEncrypted(fs.readFileSync(path.join(sub, 'c.txt'))));
  assert.strictEqual(vault.status(sub).state, 'unlocked');
});

test('hardware slots: add, unlock, wrong secret, survive password change, remove', async () => {
  const root = tempRoot();
  const note = path.join(root, 'n.txt');
  await vault.createVault(root, 'password-one');
  vault.writeFileSync(note, 'slot secret text');

  // Fake devices: a deterministic function of the salt, like HMAC on a YubiKey.
  const yubi = (salt) => crypto.createHmac('sha1', 'yubikey-secret').update(salt).digest();
  const trez = (salt) => crypto.createHmac('sha256', 'trezor-seed').update(salt).digest();
  const ySalt = vault.newSlotSalt('yubikey');
  const tSalt = vault.newSlotSalt('trezor');
  assert.strictEqual(ySalt.length, 64);
  const y = vault.addSlot(root, { type: 'yubikey', label: 'YubiKey 5C', salt: ySalt, meta: { serial: 123 } }, yubi(ySalt));
  const t = vault.addSlot(root, { type: 'trezor', label: 'Trezor Safe 3', salt: tSalt }, trez(tSalt));
  assert.deepStrictEqual(vault.listSlots(root).map(s => s.label), ['YubiKey 5C', 'Trezor Safe 3']);
  const raw = JSON.parse(fs.readFileSync(path.join(root, '.noatformat', 'vault.json'), 'utf8'));
  assert.ok(raw.wrappedKey && raw.salt, 'password fields stay at the top level');

  vault.lock(root);
  assert.throws(() => vault.addSlot(root, { type: 'trezor', salt: tSalt }, trez(tSalt)), { code: 'VAULT_LOCKED' });
  assert.throws(() => vault.unlockWithSlot(root, y.id, crypto.randomBytes(20)), { code: 'VAULT_WRONG_KEY' });
  assert.strictEqual(vault.status(root).state, 'locked');

  const slot = vault.getSlot(root, y.id);
  assert.ok(slot.salt.equals(ySalt));
  vault.unlockWithSlot(root, y.id, yubi(slot.salt));
  assert.strictEqual(vault.readFileSync(note, 'utf8'), 'slot secret text');

  vault.lock(root);
  vault.unlockWithSlot(root, t.id, trez(vault.getSlot(root, t.id).salt));
  assert.strictEqual(vault.readFileSync(note, 'utf8'), 'slot secret text');

  await vault.changePassword(root, 'password-one', 'password-two');
  assert.strictEqual(vault.listSlots(root).length, 2);
  vault.lock(root);
  vault.unlockWithSlot(root, y.id, yubi(ySalt));
  vault.lock(root);
  await vault.unlockWithPassword(root, 'password-two');

  assert.strictEqual(vault.removeSlot(root, y.id), true);
  assert.strictEqual(vault.removeSlot(root, y.id), false);
  vault.lock(root);
  assert.throws(() => vault.unlockWithSlot(root, y.id, yubi(ySalt)), /removed/);
  vault.unlockWithSlot(root, t.id, trez(tSalt));
});

test('many methods active at once: each one unlocks on its own; the same key cannot be added twice', async () => {
  const root = tempRoot();
  const note = path.join(root, 'n.txt');
  await vault.createVault(root, 'password');
  vault.writeFileSync(note, 'shared notes');

  // Two YubiKeys (a main one and a backup) and two Trezors, all different secrets.
  const keysHw = [
    { type: 'yubikey', deviceId: 'yubikey-111', secret: 'yk-main' },
    { type: 'yubikey', deviceId: 'yubikey-222', secret: 'yk-backup' },
    { type: 'trezor', deviceId: 'trezor-AAA', secret: 'tz-desk' },
    { type: 'trezor', deviceId: 'trezor-BBB', secret: 'tz-travel' }
  ];
  const answer = (k, salt) => crypto.createHmac('sha256', k.secret).update(salt).digest();
  for (const k of keysHw) {
    const salt = vault.newSlotSalt(k.type);
    k.id = vault.addSlot(root, { type: k.type, label: k.deviceId, salt, meta: { deviceId: k.deviceId } }, answer(k, salt)).id;
  }
  assert.strictEqual(vault.listSlots(root).length, 4);

  // The same physical key again is refused; assertNotEnrolled catches it before any device prompt.
  const again = vault.newSlotSalt('yubikey');
  assert.throws(() => vault.addSlot(root, { type: 'yubikey', label: 'dup', salt: again, meta: { deviceId: 'yubikey-111' } }, answer(keysHw[0], again)), { code: 'VAULT_DUPLICATE_KEY' });
  assert.throws(() => vault.assertNotEnrolled(root, 'trezor', 'trezor-AAA'), { code: 'VAULT_DUPLICATE_KEY' });
  vault.assertNotEnrolled(root, 'trezor', 'trezor-CCC');
  vault.assertNotEnrolled(root, 'yubikey', null); // serial hidden: can't tell, allowed
  assert.strictEqual(vault.listSlots(root).length, 4);

  for (const k of keysHw) {
    vault.lock(root);
    vault.unlockWithSlot(root, k.id, answer(k, vault.getSlot(root, k.id).salt));
    assert.strictEqual(vault.readFileSync(note, 'utf8'), 'shared notes', k.deviceId);
  }
  // One key's answer does not open another key's slot.
  vault.lock(root);
  assert.throws(() => vault.unlockWithSlot(root, keysHw[1].id, answer(keysHw[0], vault.getSlot(root, keysHw[1].id).salt)), { code: 'VAULT_WRONG_KEY' });
  await vault.unlockWithPassword(root, 'password');
});

test('plaintext passes through outside a vault', async () => {
  const root = tempRoot();
  const p = path.join(root, 'plain.txt');
  await vault.writeFile(p, 'just text', 'utf8');
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'just text');
  assert.strictEqual(await vault.readFile(p, 'utf8'), 'just text');
  assert.strictEqual(vault.status(root).state, 'off');
});

test('migrateFolder encrypts owned files only and decrypts back byte-identical', async () => {
  const root = tempRoot();
  const files = makeTree(root);
  const birth = fs.statSync(path.join(root, 'Shopping.txt'));
  await vault.createVault(root, 'password');

  const r1 = await vault.migrateFolder(root, 'encrypt');
  assert.strictEqual(r1.failed.length, 0);
  assert.strictEqual(r1.changed, 6);
  for (const rel of Object.keys(files)) {
    const buf = fs.readFileSync(path.join(root, rel));
    const owned = rel.endsWith('.txt') || rel.includes('.noatformat');
    assert.strictEqual(vault.isEncrypted(buf), owned, rel);
  }
  assert.ok(!vault.isEncrypted(fs.readFileSync(path.join(root, '.noatformat', 'vault.json'))));
  const after = fs.statSync(path.join(root, 'Shopping.txt'));
  assert.strictEqual(Math.round(after.mtimeMs), Math.round(birth.mtimeMs));
  assert.strictEqual(fs.readdirSync(root).filter(n => n.endsWith('.noatvault-tmp')).length, 0);

  const r2 = await vault.migrateFolder(root, 'encrypt');
  assert.strictEqual(r2.changed, 0);

  const plainAudio = await vault.withPlainTemp(path.join(root, 'Sub/.noatformat/Deep note.mp3'), (p) => {
    assert.ok(p.startsWith(vault.getSessionTmpDir()));
    return fs.readFileSync(p);
  });
  assert.deepStrictEqual(plainAudio, files['Sub/.noatformat/Deep note.mp3']);

  await vault.migrateFolder(root, 'decrypt');
  vault.removeVault(root);
  for (const [rel, data] of Object.entries(files)) {
    assert.deepStrictEqual(fs.readFileSync(path.join(root, rel)), Buffer.from(data), rel);
  }
  assert.strictEqual(vault.status(root).state, 'off');
});

test('online-only files are skipped and reported', async () => {
  const root = tempRoot();
  makeTree(root);
  await vault.createVault(root, 'password');
  const r = await vault.migrateFolder(root, 'encrypt', { shouldSkip: (st) => st.size === 512 });
  assert.strictEqual(r.skipped.length, 1);
  assert.ok(!vault.isEncrypted(fs.readFileSync(path.join(root, '.noatformat/calendar/2026-10-01.png'))));
});

test('password rules: minimum length, NFC normalisation, keyId check on the password path', async () => {
  const root = tempRoot();
  await assert.rejects(vault.createVault(root, 'short'), /at least 8/);
  assert.ok(!fs.existsSync(path.join(root, '.noatformat', 'vault.json')));
  await vault.createVault(root, 'café password'); // composed e-acute
  vault.lock(root);
  await vault.unlockWithPassword(root, 'café password'); // decomposed: same password
  await assert.rejects(vault.changePassword(root, 'café password', 'tiny'), /at least 8/);

  // The password slot of another vault spliced in: right password, wrong key.
  const other = tempRoot();
  await vault.createVault(other, 'other-password');
  const vf = (r) => path.join(r, '.noatformat', 'vault.json');
  const mine = JSON.parse(fs.readFileSync(vf(root), 'utf8'));
  const theirs = JSON.parse(fs.readFileSync(vf(other), 'utf8'));
  for (const k of ['salt', 'iv', 'wrappedKey', 'tag', 'iterations']) mine[k] = theirs[k];
  fs.writeFileSync(vf(root), JSON.stringify(mine));
  vault.lock(root);
  await assert.rejects(vault.unlockWithPassword(root, 'other-password'), { code: 'VAULT_KEY_MISMATCH' });
  assert.strictEqual(vault.status(root).state, 'locked');
});

test('remembered key: unreadable vault.json is not a mismatch; locked vault keeps its slots', async () => {
  const root = tempRoot();
  const dataKey = Buffer.from(await vault.createVault(root, 'password'));
  const salt = vault.newSlotSalt('yubikey');
  const slot = vault.addSlot(root, { type: 'yubikey', salt, meta: { deviceId: 'yubikey-1' } }, crypto.randomBytes(20));
  vault.lock(root);
  assert.strictEqual(vault.unlockWithKey(root, crypto.randomBytes(32)), false);
  assert.throws(() => vault.removeSlot(root, slot.id), { code: 'VAULT_LOCKED' });
  assert.strictEqual(vault.listSlots(root).length, 1);

  const vf = path.join(root, '.noatformat', 'vault.json');
  const good = fs.readFileSync(vf);
  fs.writeFileSync(vf, good.subarray(0, 40)); // half-synced
  assert.strictEqual(vault.unlockWithKey(root, dataKey), null);
  fs.writeFileSync(vf, good);
  assert.strictEqual(vault.unlockWithKey(root, dataKey), true);
});

test('a folder with an encrypted subfolder cannot be encrypted on top of it', async () => {
  const root = tempRoot();
  const sub = path.join(root, 'Projects', 'Secret');
  fs.mkdirSync(sub, { recursive: true });
  await vault.createVault(sub, 'password');
  await assert.rejects(vault.createVault(root, 'password'), /subfolder is already encrypted/);
  assert.ok(!fs.existsSync(path.join(root, '.noatformat', 'vault.json')));
});

test('writes see a vault.json that appeared after the folder was cached as plain', async () => {
  const src = tempRoot();
  await vault.createVault(src, 'password');
  const root = tempRoot();
  vault.writeFileSync(path.join(root, 'a.txt'), 'plain'); // caches root as "no vault"
  assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'plain');
  fs.mkdirSync(path.join(root, '.noatformat'));
  fs.copyFileSync(path.join(src, '.noatformat', 'vault.json'), path.join(root, '.noatformat', 'vault.json')); // synced in
  assert.throws(() => vault.writeFileSync(path.join(root, 'b.txt'), 'must not be plaintext'), { code: 'VAULT_LOCKED' });
  assert.ok(!fs.existsSync(path.join(root, 'b.txt')));
});

test('migration: writes into the vault wait (VAULT_BUSY) and land afterwards', async () => {
  const root = tempRoot();
  makeTree(root);
  await vault.createVault(root, 'password');
  const late = path.join(root, 'late.txt');
  let busyErr = null;
  const r = await vault.migrateFolder(root, 'encrypt', {
    onProgress: () => { if (!busyErr) { try { vault.writeFileSync(late, 'x'); } catch (e) { busyErr = e; } } }
  });
  assert.strictEqual(r.failed.length, 0);
  assert.strictEqual(busyErr && busyErr.code, 'VAULT_BUSY');
  assert.ok(!fs.existsSync(late));
  vault.writeFileSync(late, 'after');
  assert.ok(vault.isEncrypted(fs.readFileSync(late)));
  assert.strictEqual(vault.readFileSync(late, 'utf8'), 'after');
  assert.strictEqual(vault.listEncryptedFiles(root).length, 7);
});

test('migration: an interrupted in-place rewrite is finished on the next run', async () => {
  const root = tempRoot();
  const dataKey = Buffer.from(await vault.createVault(root, 'password'));
  const note = path.join(root, 'Crash.txt');
  fs.writeFileSync(note, 'the whole note');
  const st = fs.statSync(note);
  const mtime = Math.round(st.mtimeMs);
  // As left by a crash: complete target bytes in the tmp copy, note truncated
  // mid-write, plus a stray partial copy of another file.
  fs.writeFileSync(`${note}.${mtime}.noatvault-tmp`, vault.encryptBuf(dataKey, Buffer.from('the whole note')));
  fs.writeFileSync(note, 'the wh');
  fs.writeFileSync(path.join(root, 'Other.txt.1.noatvault-tmp.partial'), 'junk');
  // Edited by hand after the crash: must be kept, not overwritten.
  const edited = path.join(root, 'Edited.txt');
  fs.writeFileSync(`${edited}.${mtime}.noatvault-tmp`, vault.encryptBuf(dataKey, Buffer.from('old')));
  fs.writeFileSync(edited, 'new words typed later');
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(edited, later, later);

  const r = await vault.migrateFolder(root, 'encrypt');
  assert.strictEqual(r.recovered, 1);
  assert.strictEqual(vault.readFileSync(note, 'utf8'), 'the whole note');
  assert.strictEqual(Math.round(fs.statSync(note).mtimeMs), mtime);
  assert.strictEqual(vault.readFileSync(edited, 'utf8'), 'new words typed later');
  const names = fs.readdirSync(root);
  assert.ok(!names.some(n => n.endsWith('.partial')), 'stray partial removed');
  assert.ok(names.some(n => n.startsWith('Edited.txt.') && n.endsWith('.noatvault-tmp')), 'kept copy left for the user');
  assert.ok(!names.some(n => n.startsWith('Crash.txt.') && n.endsWith('.noatvault-tmp')));
});

test('another computer encrypting the folder holds writes here (vault.lock); a stale lock does not', async () => {
  const root = tempRoot();
  await vault.createVault(root, 'password');
  const lockPath = path.join(root, '.noatformat', vault.LOCK_FILE);
  const note = path.join(root, 'n.txt');

  fs.writeFileSync(lockPath, JSON.stringify({ host: 'OTHER-PC', pid: 1, at: Date.now() }));
  assert.throws(() => vault.writeFileSync(note, 'x'), (e) => e.code === 'VAULT_BUSY' && /OTHER-PC/.test(e.message));
  await assert.rejects(vault.migrateFolder(root, 'encrypt'), { code: 'VAULT_BUSY' });
  assert.ok(!fs.existsSync(note));

  fs.writeFileSync(lockPath, JSON.stringify({ host: 'OTHER-PC', pid: 1, at: Date.now() - 10 * 60 * 1000 }));
  vault.writeFileSync(note, 'written after the other computer died');
  assert.strictEqual(vault.readFileSync(note, 'utf8'), 'written after the other computer died');

  // Our own migration holds the lock while it runs, never encrypts it, and removes it.
  fs.unlinkSync(lockPath);
  let seen = null;
  await vault.migrateFolder(root, 'encrypt', { onProgress: () => { if (!seen) seen = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } });
  assert.strictEqual(seen.pid, process.pid);
  assert.strictEqual(seen.host, os.hostname());
  assert.ok(!fs.existsSync(lockPath), 'lock removed afterwards');
  assert.ok(!vault.listOwnedFiles(root).some(p => p.endsWith(vault.LOCK_FILE)));
});

test('atomic writes replace the file in one step and leave no temp files', async () => {
  const root = tempRoot();
  const plainFile = path.join(root, 'plain.format.json');
  vault.writeFileAtomicSync(plainFile, '{"a":1}', 'utf8');
  vault.writeFileAtomicSync(plainFile, '{"a":2}', 'utf8');
  assert.strictEqual(fs.readFileSync(plainFile, 'utf8'), '{"a":2}');

  const enc = tempRoot();
  await vault.createVault(enc, 'password');
  const encFile = path.join(enc, '.noatformat', 'n.canvas.json');
  vault.writeFileAtomicSync(encFile, '{"objects":[]}', 'utf8');
  assert.ok(vault.isEncrypted(fs.readFileSync(encFile)));
  assert.strictEqual(vault.readFileSync(encFile, 'utf8'), '{"objects":[]}');
  for (const dir of [root, path.join(enc, '.noatformat')]) {
    assert.deepStrictEqual(fs.readdirSync(dir).filter(n => n.endsWith('.tmp')), [], dir);
  }
});

test.after(() => vault.removeSessionTmpDir());
