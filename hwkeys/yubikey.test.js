const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const yk = require('./yubikey');

// Simulated YubiKey OTP HID interface: reassembles frames written as feature
// reports and answers HMAC-SHA1 / serial commands the way the device does.
function fakeYubiKey({ secret = Buffer.from('0123456789abcdef0123'), slot2 = 0x02, touchPolls = 0, reject = false, serial = 12345678 } = {}) {
  const frame = Buffer.alloc(70);
  let pending = null;   // response bytes waiting to be read
  let readSeq = 0;
  let waitPolls = 0;
  let progSeq = 7;
  const log = { writes: 0, frames: [] };

  function withCrc(data) {
    const crc = (~yk.crc16(data)) & 0xffff;
    const out = Buffer.alloc(data.length + 2);
    data.copy(out);
    out.writeUInt16LE(crc, data.length);
    return out;
  }

  function statusReport() {
    return Buffer.from([0, 5, 4, 3, progSeq, slot2 & 0xff, 0, 0]);
  }

  return {
    log,
    async getFeatureReport() {
      if (!pending) return statusReport();
      if (waitPolls > 0) { waitPolls--; return Buffer.from([0, 0, 0, 0, 0, 0, 0, 0x20]); }
      const chunks = Math.ceil(pending.length / 7);
      if (readSeq < chunks) {
        const r = Buffer.alloc(8);
        pending.subarray(readSeq * 7, readSeq * 7 + 7).copy(r);
        r[7] = 0x40 | readSeq;
        readSeq++;
        return r;
      }
      return Buffer.from([0, 0, 0, 0, 0, 0, 0, 0x40]); // sequence wrapped: done
    },
    async sendFeatureReport(r) {
      assert.strictEqual(r.length, 8);
      if (r[7] === 0xff) { pending = null; readSeq = 0; return; }
      assert.ok(r[7] & 0x80, 'write flag set');
      log.writes++;
      const seq = r[7] & 0x1f;
      r.subarray(0, 7).copy(frame, seq * 7);
      if (seq !== 9) return;
      const payload = frame.subarray(0, 64);
      assert.strictEqual(frame.readUInt16LE(65), yk.crc16(payload), 'frame CRC');
      const cmd = frame[64];
      log.frames.push(cmd);
      if (reject) { frame.fill(0); return; }
      if (cmd === 0x38) {
        pending = withCrc(crypto.createHmac('sha1', secret).update(payload).digest());
        waitPolls = touchPolls;
      } else if (cmd === 0x03) {
        // Slot 2 configuration write (ykdef.h config_st): 52 bytes + 6 bytes
        // current access code. Accepted when the CRC residual checks out and
        // the flags describe HMAC-SHA1 challenge-response.
        const cfg = payload.subarray(0, 52);
        assert.strictEqual(yk.crc16(cfg), 0xf0b8, 'config CRC residual');
        const uid = cfg.subarray(16, 22), key = cfg.subarray(22, 38);
        const extFlags = cfg[45], tktFlags = cfg[46], cfgFlags = cfg[47];
        assert.strictEqual(cfg[44], 0, 'fixedSize');
        assert.ok(tktFlags & 0x40, 'TKTFLAG_CHAL_RESP');
        assert.strictEqual(cfgFlags & 0x22, 0x22, 'CFGFLAG_CHAL_HMAC');
        assert.ok(extFlags & 0x04, 'serial stays API visible');
        log.programmed = { secret: Buffer.concat([key, uid.subarray(0, 4)]), touch: !!(cfgFlags & 0x08), lt64: !!(cfgFlags & 0x04) };
        secret = log.programmed.secret;
        slot2 = 0x02;
        progSeq++;
        pending = null;
      } else if (cmd === 0x10) {
        const s = Buffer.alloc(4);
        s.writeUInt32BE(serial);
        pending = withCrc(s);
      }
      readSeq = 0;
      frame.fill(0);
    }
  };
}

test('crc16 residual matches the YubiKey convention', () => {
  const data = Buffer.from('hello yubikey');
  const crc = (~yk.crc16(data)) & 0xffff;
  const full = Buffer.concat([data, Buffer.from([crc & 0xff, crc >> 8])]);
  assert.strictEqual(yk.crc16(full), 0xf0b8);
});

test('frames skip all-zero middle chunks but keep first and last', () => {
  const reports = yk.frameReports(yk.buildFrame(0x10, null));
  assert.deepStrictEqual(reports.map(r => r[7] & 0x1f), [0, 9]);
  const full = yk.frameReports(yk.buildFrame(0x38, crypto.randomBytes(64).fill(1)));
  assert.strictEqual(full.length, 10);
});

test('HMAC-SHA1 challenge-response returns the real HMAC', async () => {
  const secret = crypto.randomBytes(20);
  const dev = fakeYubiKey({ secret });
  const proto = new yk.OtpProtocol(dev);
  const challenge = crypto.randomBytes(64);
  const out = await proto.hmacSlot2(challenge);
  assert.deepStrictEqual(out, crypto.createHmac('sha1', secret).update(challenge).digest());
  assert.strictEqual(await proto.serial(), 12345678);
  // Deterministic: same challenge, same answer.
  assert.deepStrictEqual(await proto.hmacSlot2(challenge), out);
});

test('touch wait is reported once, then the answer arrives', async () => {
  const dev = fakeYubiKey({ touchPolls: 3 });
  let touches = 0;
  const out = await new yk.OtpProtocol(dev).hmacSlot2(crypto.randomBytes(64), { onTouch: () => touches++ });
  assert.strictEqual(out.length, 20);
  assert.strictEqual(touches, 1);
});

test('a node-hid that fails to load is reported as such, not as "no YubiKey"', async () => {
  yk.__setHidLoaderForTests(() => { throw new Error('The specified module could not be found'); });
  try {
    assert.strictEqual(yk.isAvailable(), false);
    await assert.rejects(yk.challengeResponse(crypto.randomBytes(64)), { code: 'HID_UNAVAILABLE', message: /could not be found/ });
  } finally {
    yk.__setHidLoaderForTests(null);
  }
});

test('programming slot 2 writes an HMAC-SHA1 config the key then answers with', async () => {
  const dev = fakeYubiKey({ slot2: 0 });
  const proto = new yk.OtpProtocol(dev);
  const secret = crypto.randomBytes(20);
  await proto.programHmacSlot2(secret, { requireTouch: true });
  assert.ok(dev.log.programmed.secret.equals(secret), 'secret split across key and uid');
  assert.ok(dev.log.programmed.touch && dev.log.programmed.lt64);
  const challenge = crypto.randomBytes(64);
  assert.deepStrictEqual(await proto.hmacSlot2(challenge), crypto.createHmac('sha1', secret).update(challenge).digest());
  // A programmed slot is never overwritten.
  await assert.rejects(proto.programHmacSlot2(crypto.randomBytes(20)), { code: 'SLOT_IN_USE' });
  assert.ok(dev.log.programmed.secret.equals(secret));
  // Struct layout sanity: 52 bytes, CRC residual, flags in place.
  const cfg = yk.buildHmacConfig(secret, { requireTouch: false });
  assert.strictEqual(cfg.length, 52);
  assert.strictEqual(yk.crc16(cfg), 0xf0b8);
  assert.strictEqual(cfg[47] & 0x08, 0, 'no touch flag when not required');
});

test('unconfigured or wrongly configured slot 2 gives a clear error', async () => {
  await assert.rejects(new yk.OtpProtocol(fakeYubiKey({ slot2: 0 })).hmacSlot2(crypto.randomBytes(64)), { code: 'SLOT_EMPTY', message: /empty/ });
  await assert.rejects(new yk.OtpProtocol(fakeYubiKey({ slot2: 0x0a })).hmacSlot2(crypto.randomBytes(64)), { code: 'NOT_CONFIGURED', message: /one-time password/ });
  await assert.rejects(new yk.OtpProtocol(fakeYubiKey({ reject: true })).hmacSlot2(crypto.randomBytes(64)), { code: 'NOT_CONFIGURED' });
});
