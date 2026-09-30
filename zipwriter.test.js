const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const zw = require('./zipwriter');

// Minimal reader: EOCD (+ ZIP64 locator/record), central directory, local
// headers, inflate, CRC check. Returns { name -> { data, method, time, date, flags } }.
function readZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'EOCD found');
  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  let zip64 = false;
  if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
    const loc = eocd - 20;
    assert.strictEqual(buf.readUInt32LE(loc), 0x07064b50, 'ZIP64 locator');
    const rec = Number(buf.readBigUInt64LE(loc + 8));
    assert.strictEqual(buf.readUInt32LE(rec), 0x06064b50, 'ZIP64 EOCD record');
    count = Number(buf.readBigUInt64LE(rec + 32));
    cdSize = Number(buf.readBigUInt64LE(rec + 40));
    cdOffset = Number(buf.readBigUInt64LE(rec + 48));
    zip64 = true;
  }
  const out = {};
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50, 'central header');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    let off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const extra = buf.subarray(p + 46 + nlen, p + 46 + nlen + xlen);
    if (xlen) {
      assert.strictEqual(extra.readUInt16LE(0), 0x0001, 'ZIP64 extra');
      let q = 4;
      if (usize === 0xFFFFFFFF) { usize = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (csize === 0xFFFFFFFF) { csize = Number(extra.readBigUInt64LE(q)); q += 8; }
      if (off === 0xFFFFFFFF) { off = Number(extra.readBigUInt64LE(q)); q += 8; }
    }
    assert.strictEqual(buf.readUInt32LE(off), 0x04034b50, 'local header');
    const lnlen = buf.readUInt16LE(off + 26);
    const lxlen = buf.readUInt16LE(off + 28);
    assert.strictEqual(buf.subarray(off + 30, off + 30 + lnlen).toString('utf8'), name, 'local name matches');
    const start = off + 30 + lnlen + lxlen;
    const body = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    assert.strictEqual(data.length, usize, `${name} size`);
    assert.strictEqual(zw.crc32(data), crc, `${name} crc`);
    out[name] = { data, method, time, date, flags };
    p += 46 + nlen + xlen + clen;
  }
  return { entries: out, zip64, count };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'noatzip-test-'));
}

test('crc32 matches the reference value', () => {
  assert.strictEqual(zw.crc32(Buffer.from('123456789')), 0xCBF43926);
  assert.strictEqual(zw.crc32(Buffer.alloc(0)), 0);
});

test('round-trip: text, binary, empty and non-ASCII names in nested folders', async () => {
  const dir = tmpDir();
  const files = {
    'Notes/Shopping.txt': Buffer.from('eggs\nmilk\n'.repeat(200)),
    'Notes/Sub/Déjà vu – ünïcode 笔记.txt': Buffer.from('non-ascii name'),
    'Notes/.noatformat/rec.mp3': crypto.randomBytes(50000),
    'Notes/empty.txt': Buffer.alloc(0)
  };
  const mtime = new Date(2026, 8, 29, 14, 37, 51);
  const entries = [];
  for (const [rel, data] of Object.entries(files)) {
    const p = path.join(dir, 'src', ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
    entries.push({ name: rel, path: p, mtime });
  }
  const out = path.join(dir, 'backup.zip');
  const progress = [];
  const r = await zw.writeZip(out, entries, { onProgress: (x) => progress.push(x.done) });
  assert.strictEqual(r.files, 4);
  assert.deepStrictEqual(progress, [1, 2, 3, 4]);
  assert.ok(!fs.existsSync(out + '.partial'));

  const { entries: got, zip64 } = readZip(fs.readFileSync(out));
  assert.strictEqual(zip64, false);
  for (const [rel, data] of Object.entries(files)) {
    assert.ok(got[rel], `${rel} present`);
    assert.ok(got[rel].data.equals(data), `${rel} bytes`);
    assert.ok(got[rel].flags & 0x0800, 'UTF-8 flag');
  }
  assert.strictEqual(got['Notes/Shopping.txt'].method, 8, 'compressible text is deflated');
  assert.strictEqual(got['Notes/.noatformat/rec.mp3'].method, 0, 'random bytes are stored');
  assert.strictEqual(got['Notes/empty.txt'].method, 0);

  // DOS time round-trips at 2-second precision.
  const t = got['Notes/Shopping.txt'];
  assert.strictEqual(t.date, ((2026 - 1980) << 9) | (9 << 5) | 29);
  assert.strictEqual(t.time, (14 << 11) | (37 << 5) | 25);
});

test('ZIP64 records are written when the limits are exceeded', async () => {
  const dir = tmpDir();
  const entries = [];
  for (let i = 0; i < 5; i++) {
    const p = path.join(dir, `f${i}.bin`);
    fs.writeFileSync(p, crypto.randomBytes(300 + i));
    entries.push({ name: `f${i}.bin`, path: p });
  }
  const out = path.join(dir, 'big.zip');
  await zw.writeZip(out, entries, { limits: { u32: 256, u16: 3 } });
  const { entries: got, zip64, count } = readZip(fs.readFileSync(out));
  assert.ok(zip64);
  assert.strictEqual(count, 5);
  for (let i = 0; i < 5; i++) assert.ok(got[`f${i}.bin`].data.equals(fs.readFileSync(entries[i].path)));
});

test('unreadable files are skipped and reported; a hard failure leaves no partial file', async () => {
  const dir = tmpDir();
  const ok = path.join(dir, 'ok.txt');
  fs.writeFileSync(ok, 'fine');
  const out = path.join(dir, 'b.zip');
  const r = await zw.writeZip(out, [{ name: 'gone.txt', path: path.join(dir, 'missing.txt') }, { name: 'ok.txt', path: ok }]);
  assert.strictEqual(r.files, 1);
  assert.strictEqual(r.skipped.length, 1);
  assert.strictEqual(r.skipped[0].name, 'gone.txt');
  assert.ok(readZip(fs.readFileSync(out)).entries['ok.txt']);

  const out2 = path.join(dir, 'bad.zip');
  await assert.rejects(zw.writeZip(out2, [{ name: '../', path: ok }]), /Bad entry name/);
  assert.ok(!fs.existsSync(out2) && !fs.existsSync(out2 + '.partial'));
});

test('entry names are cleaned: backslashes, leading slashes and .. segments', () => {
  assert.strictEqual(zw.cleanName('\\a\\b\\..\\c.txt'), 'a/b/c.txt');
  assert.strictEqual(zw.cleanName('/x/./y'), 'x/y');
});
