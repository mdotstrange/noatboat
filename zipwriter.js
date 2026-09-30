// Streaming .zip writer for folder backups. Files are added one at a time
// (read, deflate, write), so memory use is bounded by the largest single
// file, not the whole folder. Names are UTF-8 (general-purpose bit 11),
// timestamps are DOS date/time from each file's mtime, and ZIP64 records are
// written only when a size, offset or entry count needs them.
//
// The archive is written to <out>.partial and renamed into place at the end,
// so a failed or interrupted backup never leaves a truncated .zip behind.
//
// No Electron imports: main.js uses it, and the tests run under plain node.

const fs = require('fs');
const fsp = fs.promises;
const zlib = require('zlib');

const PARTIAL_SUFFIX = '.partial';
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;

let crcTable = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// DOS date/time (local time, 2-second resolution, 1980..2107).
function dosDateTime(d) {
  let date = d instanceof Date && !isNaN(d) ? d : new Date();
  if (date.getFullYear() < 1980) date = new Date(1980, 0, 1, 0, 0, 0);
  if (date.getFullYear() > 2107) date = new Date(2107, 11, 31, 23, 59, 58);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

// Entry name inside the archive: forward slashes, no leading slash, no "..".
function cleanName(name) {
  const parts = String(name).replace(/\\/g, '/').split('/').filter(p => p && p !== '.' && p !== '..');
  if (!parts.length) throw new Error(`Bad entry name: ${name}`);
  return parts.join('/');
}

// entries: [{ name, path, mtime? }]. opts.onProgress({ done, total, name }).
// opts.limits ({ u16, u32 }) lowers the ZIP64 thresholds (tests only).
// Returns { files, bytes, skipped: [{ name, error }] }; an entry whose file
// cannot be read (vanished, locked by another program) is skipped and
// reported, anything else aborts and removes the partial file.
async function writeZip(outPath, entries, opts = {}) {
  const U32 = (opts.limits && opts.limits.u32) || 0xFFFFFFFF;
  const U16 = (opts.limits && opts.limits.u16) || 0xFFFF;
  const partial = outPath + PARTIAL_SUFFIX;
  const fh = await fsp.open(partial, 'w');
  let offset = 0;
  const central = [];
  const skipped = [];
  let bytes = 0;

  const write = async (buf) => {
    let pos = 0;
    while (pos < buf.length) {
      const { bytesWritten } = await fh.write(buf, pos, buf.length - pos);
      pos += bytesWritten;
    }
    offset += buf.length;
  };

  try {
    let done = 0;
    for (const e of entries) {
      const name = cleanName(e.name);
      let data;
      try {
        data = await fsp.readFile(e.path);
      } catch (err) {
        skipped.push({ name, error: String((err && err.message) || err) });
        done++;
        if (opts.onProgress) opts.onProgress({ done, total: entries.length, name });
        continue;
      }
      const deflated = data.length ? zlib.deflateRawSync(data) : data;
      const useDeflate = data.length > 0 && deflated.length < data.length;
      const body = useDeflate ? deflated : data;
      const crc = crc32(data);
      const nameBuf = Buffer.from(name, 'utf8');
      const { time, date } = dosDateTime(e.mtime);
      const localOffset = offset;

      const sizes64 = data.length >= U32 || body.length >= U32;
      const localExtra = sizes64
        ? Buffer.concat([Buffer.from([0x01, 0x00, 16, 0x00]), u64(data.length), u64(body.length)])
        : Buffer.alloc(0);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(sizes64 ? VERSION_ZIP64 : VERSION_DEFAULT, 4);
      lh.writeUInt16LE(FLAG_UTF8, 6);
      lh.writeUInt16LE(useDeflate ? METHOD_DEFLATE : METHOD_STORE, 8);
      lh.writeUInt16LE(time, 10);
      lh.writeUInt16LE(date, 12);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(sizes64 ? 0xFFFFFFFF : body.length, 18);
      lh.writeUInt32LE(sizes64 ? 0xFFFFFFFF : data.length, 22);
      lh.writeUInt16LE(nameBuf.length, 26);
      lh.writeUInt16LE(localExtra.length, 28);
      await write(Buffer.concat([lh, nameBuf, localExtra]));
      await write(body);

      central.push({ nameBuf, crc, time, date, method: useDeflate ? METHOD_DEFLATE : METHOD_STORE, csize: body.length, usize: data.length, offset: localOffset });
      bytes += data.length;
      done++;
      if (opts.onProgress) opts.onProgress({ done, total: entries.length, name });
    }

    // Central directory.
    const cdOffset = offset;
    for (const c of central) {
      const zu = c.usize >= U32, zc = c.csize >= U32, zo = c.offset >= U32;
      const extraParts = [];
      if (zu) extraParts.push(u64(c.usize));
      if (zc) extraParts.push(u64(c.csize));
      if (zo) extraParts.push(u64(c.offset));
      let extra = Buffer.alloc(0);
      if (extraParts.length) {
        const payload = Buffer.concat(extraParts);
        const head = Buffer.alloc(4);
        head.writeUInt16LE(0x0001, 0);
        head.writeUInt16LE(payload.length, 2);
        extra = Buffer.concat([head, payload]);
      }
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(extra.length ? VERSION_ZIP64 : VERSION_DEFAULT, 4); // made by: MS-DOS host
      ch.writeUInt16LE(extra.length ? VERSION_ZIP64 : VERSION_DEFAULT, 6);
      ch.writeUInt16LE(FLAG_UTF8, 8);
      ch.writeUInt16LE(c.method, 10);
      ch.writeUInt16LE(c.time, 12);
      ch.writeUInt16LE(c.date, 14);
      ch.writeUInt32LE(c.crc, 16);
      ch.writeUInt32LE(zc ? 0xFFFFFFFF : c.csize, 20);
      ch.writeUInt32LE(zu ? 0xFFFFFFFF : c.usize, 24);
      ch.writeUInt16LE(c.nameBuf.length, 28);
      ch.writeUInt16LE(extra.length, 30);
      ch.writeUInt16LE(0, 32); // comment
      ch.writeUInt16LE(0, 34); // disk
      ch.writeUInt16LE(0, 36); // internal attributes
      ch.writeUInt32LE(0, 38); // external attributes
      ch.writeUInt32LE(zo ? 0xFFFFFFFF : c.offset, 42);
      await write(Buffer.concat([ch, c.nameBuf, extra]));
    }
    const cdSize = offset - cdOffset;
    const count = central.length;

    const need64 = count >= U16 || cdSize >= U32 || cdOffset >= U32;
    if (need64) {
      const z64Offset = offset;
      const rec = Buffer.alloc(56);
      rec.writeUInt32LE(0x06064b50, 0);
      u64(44).copy(rec, 4); // size of the rest of the record
      rec.writeUInt16LE(VERSION_ZIP64, 12);
      rec.writeUInt16LE(VERSION_ZIP64, 14);
      rec.writeUInt32LE(0, 16);
      rec.writeUInt32LE(0, 20);
      u64(count).copy(rec, 24);
      u64(count).copy(rec, 32);
      u64(cdSize).copy(rec, 40);
      u64(cdOffset).copy(rec, 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeUInt32LE(0, 4);
      u64(z64Offset).copy(loc, 8);
      loc.writeUInt32LE(1, 16);
      await write(Buffer.concat([rec, loc]));
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(need64 ? 0xFFFF : count, 8);
    eocd.writeUInt16LE(need64 ? 0xFFFF : count, 10);
    eocd.writeUInt32LE(need64 ? 0xFFFFFFFF : cdSize, 12);
    eocd.writeUInt32LE(need64 ? 0xFFFFFFFF : cdOffset, 16);
    eocd.writeUInt16LE(0, 20);
    await write(eocd);

    await fh.sync();
    await fh.close();
    await fsp.rename(partial, outPath);
    return { files: central.length, bytes, size: offset, skipped };
  } catch (err) {
    try { await fh.close(); } catch (_e) {}
    try { await fsp.unlink(partial); } catch (_e) {}
    throw err;
  }
}

module.exports = { writeZip, crc32, dosDateTime, cleanName, PARTIAL_SUFFIX };
