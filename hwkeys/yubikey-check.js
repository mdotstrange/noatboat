// YubiKey diagnostics for Noat Boat: lists what the OS shows, then talks the
// OTP protocol (status, serial, and an HMAC-SHA1 challenge on slot 2 that
// waits for a touch). Run from the repo:
//
//   npm run yubikey-check
//
// It runs under Electron so the native node-hid module built for the app is
// used; nothing is written anywhere.

const path = require('path');
const crypto = require('crypto');

let app = null;
try {
  const electron = require('electron');
  if (electron && electron.app && typeof electron.app.on === 'function') app = electron.app;
} catch (_e) {}

const yk = require(path.join(__dirname, 'yubikey.js'));

function log(...a) { console.log(...a); }

async function main() {
  let HID;
  try {
    HID = require('node-hid');
  } catch (e) {
    log('node-hid failed to load:', e.message);
    log('Run "npm install" (it rebuilds node-hid for Electron) and try again.');
    return 2;
  }
  const all = HID.devices();
  const yubi = all.filter(d => d.vendorId === 0x1050);
  log(`HID devices visible: ${all.length}, Yubico (vendor 0x1050): ${yubi.length}`);
  for (const d of yubi) {
    log(`  product=${JSON.stringify(d.product)} pid=0x${d.productId.toString(16)} interface=${d.interface} usagePage=${d.usagePage} usage=${d.usage}`);
  }
  let otp = [];
  try { otp = yk.listYubiKeys(); } catch (e) { log('listYubiKeys failed:', e.code, e.message); return 2; }
  log(`OTP (keyboard) interfaces matched: ${otp.length}`);
  if (!otp.length) {
    log(yubi.length
      ? 'A YubiKey is attached but its OTP interface is not visible: enable "OTP" under the USB interfaces in Yubico Authenticator, then unplug and reinsert it.'
      : 'No YubiKey is attached (or Windows does not expose it to this user).');
    return 1;
  }

  for (const info of otp) {
    log(`--- ${info.product || 'YubiKey'} at ${info.path}`);
    let dev;
    try {
      dev = await HID.HIDAsync.open(info.path);
    } catch (e) {
      log('  open failed:', e.message);
      continue;
    }
    try {
      const raw = Buffer.from(await dev.getFeatureReport(0, 9));
      log(`  raw feature report (${raw.length} bytes): ${raw.toString('hex')}`);
      const proto = new yk.OtpProtocol({
        async getFeatureReport() {
          const r = Buffer.from(await dev.getFeatureReport(0, 9));
          return r.length === 9 ? r.subarray(1) : r.subarray(0, 8);
        },
        async sendFeatureReport(report) { await dev.sendFeatureReport(Buffer.concat([Buffer.from([0]), report])); }
      });
      const st = await proto.status();
      log(`  firmware ${st.version.join('.')}, progSeq ${st.progSeq}, touchLevel 0x${st.touchLevel.toString(16)}`);
      log(`  slot 1: ${st.touchLevel & 1 ? 'programmed' : 'empty'}${st.touchLevel & 4 ? ' (touch-triggered OTP/static)' : ''}`);
      log(`  slot 2: ${st.touchLevel & 2 ? 'programmed' : 'empty'}${st.touchLevel & 8 ? ' (touch-triggered OTP/static, NOT challenge-response)' : ''}`);
      try { log(`  serial: ${await proto.serial()}`); } catch (e) { log(`  serial: not readable (${e.code}: ${e.message})`); }

      log('  sending an HMAC-SHA1 challenge to slot 2 (touch the key if it blinks; 25 s)...');
      const t0 = Date.now();
      try {
        const r = await proto.hmacSlot2(crypto.randomBytes(64), {
          onTouch: () => log(`  -> the key asks for a TOUCH (after ${Date.now() - t0} ms)`),
          timeoutMs: 25000
        });
        log(`  HMAC OK: ${r.toString('hex')} (after ${Date.now() - t0} ms)`);
        log('  This YubiKey works with Noat Boat.');
      } catch (e) {
        log(`  HMAC failed: ${e.code}: ${e.message} (after ${Date.now() - t0} ms)`);
        if (e.code === 'SLOT_EMPTY') log('  Preferences > Encryption > Add YubiKey in Noat Boat offers to set Slot 2 up for you.');
      }
    } finally {
      try { await dev.close(); } catch (_e) {}
    }
  }
  return 0;
}

const run = () => main().then((code) => {
  if (app) app.exit(code); else process.exit(code);
}).catch((e) => {
  log('check failed:', e && e.stack || e);
  if (app) app.exit(2); else process.exit(2);
});

if (app) app.whenReady().then(run); else run();
