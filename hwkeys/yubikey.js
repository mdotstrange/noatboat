// YubiKey HMAC-SHA1 challenge-response over the OTP HID interface (the method
// KeePassXC uses). Slot 2 must be set up for challenge-response in Yubico
// Authenticator / YubiKey Manager. The OTP interface is a HID keyboard, but
// challenge-response only uses feature reports, which need no admin rights.
//
// Protocol port of yubikey-manager's yubikit/core/otp.py: a 70-byte frame
// (64-byte payload, slot command, CRC16, filler) goes out as 7-byte chunks in
// 8-byte feature reports; the response comes back the same way.

const crypto = require('crypto');

const YUBICO_VID = 0x1050;
const REPORT_SIZE = 8;
const REPORT_DATA = 7;
const PAYLOAD_SIZE = 64;

const SLOT_WRITE_FLAG = 0x80;
const RESP_PENDING_FLAG = 0x40;
const RESP_TIMEOUT_WAIT_FLAG = 0x20;
const SEQUENCE_MASK = 0x1f;
const CRC_OK_RESIDUAL = 0xf0b8;

const CMD_CONFIG2 = 0x03;       // write a new configuration into slot 2
const CMD_DEVICE_SERIAL = 0x10;
const CMD_CHAL_HMAC2 = 0x38;
const HMAC_RESPONSE_SIZE = 20;
const HMAC_KEY_SIZE = 20;

// Slot configuration struct (ykdef.h config_st): fixed[16] uid[6] key[16]
// accCode[6] fixedSize extFlags tktFlags cfgFlags rfu[2] crc(LE, ~crc16).
const CFG_FIXED_SIZE = 16;
const CFG_UID_SIZE = 6;
const CFG_KEY_SIZE = 16;
const CFG_ACC_CODE_SIZE = 6;
const CFG_SIZE = 52;
const TKTFLAG_CHAL_RESP = 0x40;
const CFGFLAG_CHAL_HMAC = 0x22;
const CFGFLAG_HMAC_LT64 = 0x04;
const CFGFLAG_CHAL_BTN_TRIG = 0x08;
const EXTFLAG_SERIAL_API_VISIBLE = 0x04;
const EXTFLAG_ALLOW_UPDATE = 0x20;

// Touch-level bits in the status report
const CFGSTATE_SLOT2_VALID = 0x02;
const CFGSTATE_SLOT2_TOUCH = 0x08; // slot 2 outputs on touch (OTP/static), not chal-resp

class YubiKeyError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function crc16(data) {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      const j = crc & 1;
      crc >>= 1;
      if (j) crc ^= 0x8408;
    }
  }
  return crc & 0xffff;
}

function buildFrame(cmd, data) {
  const payload = Buffer.alloc(PAYLOAD_SIZE);
  if (data) {
    if (data.length > PAYLOAD_SIZE) throw new Error('Payload too large');
    Buffer.from(data).copy(payload);
  }
  const frame = Buffer.alloc(PAYLOAD_SIZE + 6);
  payload.copy(frame);
  frame[64] = cmd;
  frame.writeUInt16LE(crc16(payload), 65);
  return frame;
}

// Slot configuration for HMAC-SHA1 challenge-response with a 20-byte secret,
// as yubikey-manager's HmacSha1SlotConfiguration builds it: secret bytes 0-15
// go in key, 16-19 in uid; variable-length challenges (HMAC_LT64); touch
// required when requireTouch. No access code.
function buildHmacConfig(secret, { requireTouch = true } = {}) {
  if (!secret || secret.length !== HMAC_KEY_SIZE) throw new Error('HMAC secret must be 20 bytes');
  const cfg = Buffer.alloc(CFG_SIZE);
  const uidOff = CFG_FIXED_SIZE;
  const keyOff = uidOff + CFG_UID_SIZE;
  const flagsOff = keyOff + CFG_KEY_SIZE + CFG_ACC_CODE_SIZE; // fixedSize
  secret.copy(cfg, uidOff, CFG_KEY_SIZE, HMAC_KEY_SIZE);
  secret.copy(cfg, keyOff, 0, CFG_KEY_SIZE);
  cfg[flagsOff] = 0; // fixedSize
  cfg[flagsOff + 1] = EXTFLAG_SERIAL_API_VISIBLE | EXTFLAG_ALLOW_UPDATE;
  cfg[flagsOff + 2] = TKTFLAG_CHAL_RESP;
  cfg[flagsOff + 3] = CFGFLAG_CHAL_HMAC | CFGFLAG_HMAC_LT64 | (requireTouch ? CFGFLAG_CHAL_BTN_TRIG : 0);
  cfg.writeUInt16LE((~crc16(cfg.subarray(0, CFG_SIZE - 2))) & 0xffff, CFG_SIZE - 2);
  return cfg;
}

// The frame as feature reports: all-zero chunks are skipped except the first
// and the last.
function frameReports(frame) {
  const out = [];
  for (let seq = 0; seq * REPORT_DATA < frame.length; seq++) {
    const chunk = frame.subarray(seq * REPORT_DATA, (seq + 1) * REPORT_DATA);
    if (seq === 0 || seq === 9 || chunk.some(b => b !== 0)) {
      out.push(Buffer.concat([chunk, Buffer.from([0x80 | seq])]));
    }
  }
  return out;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// dev: { getFeatureReport(): Promise<Buffer(8)>, sendFeatureReport(Buffer(8)): Promise }
class OtpProtocol {
  constructor(dev) {
    this.dev = dev;
  }

  async receive() {
    const r = await this.dev.getFeatureReport();
    if (!r || r.length !== REPORT_SIZE) throw new YubiKeyError('Unexpected response from YubiKey', 'IO');
    return r;
  }

  // { version: [a,b,c], progSeq, touchLevel }
  async status() {
    const r = await this.receive();
    return { version: [r[1], r[2], r[3]], progSeq: r[4], touchLevel: r[5] | (r[6] << 8) };
  }

  async awaitReadyToWrite() {
    for (let i = 0; i < 20; i++) {
      if (((await this.receive())[REPORT_DATA] & SLOT_WRITE_FLAG) === 0) return;
      await sleep(50);
    }
    throw new YubiKeyError('YubiKey is not responding', 'IO');
  }

  async resetState() {
    const r = Buffer.alloc(REPORT_SIZE);
    r[REPORT_SIZE - 1] = 0xff;
    await this.dev.sendFeatureReport(r);
  }

  // Returns the raw response bytes (multiple of 7), or throws.
  async sendAndReceive(cmd, data, { onTouch, timeoutMs = 20000 } = {}) {
    const progSeq = (await this.receive())[4];
    for (const report of frameReports(buildFrame(cmd, data))) {
      await this.awaitReadyToWrite();
      await this.dev.sendFeatureReport(report);
    }

    let response = Buffer.alloc(0);
    let seq = 0;
    let needsTouch = false;
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        const report = await this.receive();
        const statusByte = report[REPORT_DATA];
        if (statusByte & RESP_PENDING_FLAG) {
          if (seq === (statusByte & SEQUENCE_MASK)) {
            response = Buffer.concat([response, report.subarray(0, REPORT_DATA)]);
            seq++;
          } else if ((statusByte & SEQUENCE_MASK) === 0) {
            await this.resetState();
            return response;
          }
        } else if (statusByte === 0) {
          // A plain status report: the command was rejected or timed out.
          if (response.length) throw new YubiKeyError('Incomplete response from YubiKey', 'IO');
          if (needsTouch) throw new YubiKeyError('Timed out waiting for you to touch the YubiKey', 'TOUCH_TIMEOUT');
          if (report[4] !== progSeq) return Buffer.alloc(0);
          throw new YubiKeyError('The YubiKey rejected the request', 'REJECTED');
        } else {
          if (Date.now() > deadline) throw new YubiKeyError('Timed out waiting for the YubiKey', 'TOUCH_TIMEOUT');
          if ((statusByte & RESP_TIMEOUT_WAIT_FLAG) && !needsTouch) {
            needsTouch = true;
            if (onTouch) onTouch();
          }
          await sleep(needsTouch ? 100 : 20);
        }
      }
    } catch (e) {
      try { await this.resetState(); } catch (_e) {}
      throw e;
    }
  }

  async sendChecked(cmd, data, expectedLen, opts) {
    const resp = await this.sendAndReceive(cmd, data, opts);
    if (resp.length < expectedLen + 2 || crc16(resp.subarray(0, expectedLen + 2)) !== CRC_OK_RESIDUAL) {
      throw new YubiKeyError('Bad response from YubiKey (CRC)', 'IO');
    }
    return resp.subarray(0, expectedLen);
  }

  async serial() {
    return (await this.sendChecked(CMD_DEVICE_SERIAL, null, 4)).readUInt32BE(0);
  }

  // HMAC-SHA1 of a 64-byte challenge with the secret in slot 2.
  async hmacSlot2(challenge, opts) {
    if (!challenge || challenge.length !== PAYLOAD_SIZE) throw new Error('Challenge must be 64 bytes');
    const st = await this.status();
    if (!(st.touchLevel & CFGSTATE_SLOT2_VALID)) {
      throw new YubiKeyError('Slot 2 of this YubiKey is empty and needs to be set up for HMAC-SHA1 challenge-response.', 'SLOT_EMPTY');
    }
    if (st.touchLevel & CFGSTATE_SLOT2_TOUCH) {
      throw new YubiKeyError('Slot 2 of this YubiKey holds a one-time password, not challenge-response.', 'NOT_CONFIGURED');
    }
    try {
      return Buffer.from(await this.sendChecked(CMD_CHAL_HMAC2, challenge, HMAC_RESPONSE_SIZE, opts));
    } catch (e) {
      if (e.code === 'REJECTED') {
        throw new YubiKeyError('Slot 2 of this YubiKey is not set up for HMAC-SHA1 challenge-response.', 'NOT_CONFIGURED');
      }
      throw e;
    }
  }

  // Program slot 2 for HMAC-SHA1 challenge-response with secret. Refuses when
  // slot 2 already holds something: that is the user's to clear. The key
  // answers a config write with a status report whose programming sequence
  // number advanced.
  async programHmacSlot2(secret, opts) {
    const before = await this.status();
    if (before.touchLevel & CFGSTATE_SLOT2_VALID) {
      throw new YubiKeyError('Slot 2 of this YubiKey is already programmed - nothing was changed.', 'SLOT_IN_USE');
    }
    const payload = Buffer.concat([buildHmacConfig(secret, opts), Buffer.alloc(CFG_ACC_CODE_SIZE)]); // + current access code (none)
    try {
      await this.sendAndReceive(CMD_CONFIG2, payload, { timeoutMs: 5000 });
    } catch (e) {
      if (e.code === 'REJECTED') throw new YubiKeyError('The YubiKey refused the new Slot 2 configuration.', 'PROGRAM_FAILED');
      throw e;
    }
    const after = await this.status();
    if (!(after.touchLevel & CFGSTATE_SLOT2_VALID) || after.progSeq === before.progSeq) {
      throw new YubiKeyError('The YubiKey did not take the new Slot 2 configuration.', 'PROGRAM_FAILED');
    }
  }
}

// ---------------------------------------------------------------------------
// node-hid transport

let HIDModule = null;
let hidLoadError = null; // node-hid failed to load (e.g. not rebuilt for this Electron)
let loadHid = () => require('node-hid');

function hid() {
  if (HIDModule) return HIDModule;
  if (hidLoadError) throw hidLoadError;
  try {
    HIDModule = loadHid();
  } catch (e) {
    hidLoadError = new YubiKeyError(`YubiKey support is unavailable: ${e.message}`, 'HID_UNAVAILABLE');
    throw hidLoadError;
  }
  return HIDModule;
}

// Tests swap the module loader in; resets the cached module and load error.
function __setHidLoaderForTests(fn) {
  loadHid = fn || (() => require('node-hid'));
  HIDModule = null;
  hidLoadError = null;
}

// OTP keyboard interfaces of attached YubiKeys. Throws HID_UNAVAILABLE when
// node-hid itself cannot be loaded (so that is reported, not "no key found");
// other enumeration failures read as no devices.
function listYubiKeys() {
  let devices = [];
  try {
    devices = hid().devices();
  } catch (e) {
    if (e && e.code === 'HID_UNAVAILABLE') throw e;
    return [];
  }
  const seen = new Set();
  return devices.filter(d => {
    if (d.vendorId !== YUBICO_VID || !d.path) return false;
    const isOtp = (d.usagePage === 1 && d.usage === 6) || (d.usagePage === undefined && d.interface === 0);
    if (!isOtp || seen.has(d.path)) return false;
    seen.add(d.path);
    return true;
  });
}

async function openOtp(info) {
  const dev = await hid().HIDAsync.open(info.path);
  return {
    async getFeatureReport() {
      const r = Buffer.from(await dev.getFeatureReport(0, REPORT_SIZE + 1));
      // With report ID 0 the buffer normally leads with that ID byte.
      return r.length === REPORT_SIZE + 1 ? r.subarray(1) : r.subarray(0, REPORT_SIZE);
    },
    async sendFeatureReport(report) {
      await dev.sendFeatureReport(Buffer.concat([Buffer.from([0]), report]));
    },
    async close() {
      try { await dev.close(); } catch (_e) {}
    }
  };
}

async function withFirstYubiKey(fn) {
  const found = listYubiKeys();
  if (!found.length) {
    throw new YubiKeyError('No YubiKey found. Plug one in; if it is plugged in, its OTP interface is turned off - enable "OTP" under the USB interfaces in Yubico Authenticator, then unplug and reinsert it.', 'NO_DEVICE');
  }
  let lastErr = null;
  for (const info of found) {
    let dev;
    try {
      dev = await openOtp(info);
    } catch (e) {
      lastErr = new YubiKeyError(`Could not open the YubiKey: ${e.message}`, 'OPEN_FAILED');
      continue;
    }
    try {
      return await fn(new OtpProtocol(dev), info);
    } finally {
      await dev.close();
    }
  }
  throw lastErr;
}

// { serial, secret } for the first attached YubiKey.
async function challengeResponse(challenge, opts = {}) {
  return withFirstYubiKey(async (proto, info) => {
    const secret = await proto.hmacSlot2(challenge, opts);
    let serial = null;
    try { serial = await proto.serial(); } catch (_e) { /* serial can be hidden */ }
    return { secret, serial, product: info.product || 'YubiKey' };
  });
}

// Program slot 2 of the first attached YubiKey with a fresh random secret for
// HMAC-SHA1 challenge-response, touch required. The secret is not kept: only
// the key can answer challenges from now on. Refuses a slot that is in use.
async function setupSlot2() {
  return withFirstYubiKey(async (proto, info) => {
    const secret = crypto.randomBytes(HMAC_KEY_SIZE);
    try {
      await proto.programHmacSlot2(secret, { requireTouch: true });
    } finally {
      secret.fill(0);
    }
    return { product: info.product || 'YubiKey' };
  });
}

function isAvailable() {
  try { return listYubiKeys().length > 0; } catch (_e) { return false; }
}

module.exports = {
  YubiKeyError,
  OtpProtocol,
  crc16,
  buildFrame,
  buildHmacConfig,
  frameReports,
  listYubiKeys,
  isAvailable,
  challengeResponse,
  setupSlot2,
  __setHidLoaderForTests
};
