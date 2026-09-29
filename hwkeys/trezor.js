// Trezor unlock via cipherKeyValue (SLIP-0011, as used by Trezor Password
// Manager). The device encrypts a stored nonce with a key derived from its
// seed, the path and the prompt text, so the output is the same every time
// (and after restoring the seed on another Trezor). The user confirms on the
// device; PIN entry happens on the device (Trezor T / Safe).
//
// Newer firmware speaks the Trezor Host Protocol (THP): the first time a
// computer talks to the device it must be paired by typing a code the Trezor
// shows. The pairing credentials are handed to the credential store (main.js
// keeps them in config.json) so pairing is a one-time step per computer.
//
// @trezor/connect is large, so it is only loaded when a Trezor is used.
// Requests run one at a time: the UI callbacks below are module-level.

const os = require('os');

const PATH = "m/10016'/0";
const PROMPT = 'Unlock Noat Boat notes?';
const PAIRING_CODE_LEN = 6;

let connect = null;   // TrezorConnect instance once initialised
let initPromise = null;
let onEventCb = null;  // (message) -> void for the running request
let onPromptCb = null; // ({ kind, message, length }) -> Promise<string|null> for the running request
let noDeviceTimer = null;
let unacquiredTimer = null; // "in use by another app" is only reported if it persists
let cancelReason = null; // TrezorError explaining a cancel we issued ourselves
let queue = Promise.resolve();
let credentialStore = null; // { get(): { staticKey, knownCredentials }, set({ staticKey, knownCredentials }) }
const NO_DEVICE_WAIT_MS = Number(process.env.NOATBOAT_TREZOR_WAIT_MS) || 30000;

class TrezorError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function setCredentialStore(store) {
  credentialStore = store || null;
}

function emit(message) {
  if (onEventCb) { try { onEventCb(message); } catch (_e) {} }
}

function stopNoDeviceTimer() {
  clearTimeout(noDeviceTimer);
  noDeviceTimer = null;
}

function storedCredentials() {
  try {
    const c = credentialStore && credentialStore.get();
    return {
      staticKey: c && typeof c.staticKey === 'string' && c.staticKey ? c.staticKey : undefined,
      knownCredentials: c && Array.isArray(c.knownCredentials) ? c.knownCredentials.slice() : []
    };
  } catch (_e) {
    return { staticKey: undefined, knownCredentials: [] };
  }
}

// The device showed a pairing code: ask the user for it and hand it to Connect.
async function answerPairing(TrezorConnect, UI) {
  emit('Pair this computer: type the code shown on your Trezor');
  let code = null;
  try {
    code = onPromptCb ? await onPromptCb({
      kind: 'code',
      message: `Enter the ${PAIRING_CODE_LEN}-digit code shown on your Trezor to pair it with this computer`,
      length: PAIRING_CODE_LEN
    }) : null;
  } catch (_e) { code = null; }
  code = code == null ? '' : String(code).replace(/\s+/g, '');
  if (!code) {
    cancelReason = new TrezorError('Pairing cancelled', 'CANCELLED');
    TrezorConnect.cancel('Pairing cancelled');
    return;
  }
  emit('Checking the code...');
  TrezorConnect.uiResponse({ type: UI.RECEIVE_THP_PAIRING_TAG, payload: { tag: code } });
}

async function getConnect() {
  if (connect) return connect;
  if (!initPromise) {
    initPromise = (async () => {
      const mod = require('@trezor/connect');
      const TrezorConnect = mod.default;
      const { UI_EVENT, UI, DEVICE_EVENT, DEVICE } = mod;
      TrezorConnect.on(UI_EVENT, (event) => {
        const type = event && event.type;
        const payload = event && event.payload;
        const noDevice = type === UI.SELECT_DEVICE && !((payload && payload.devices) || []).length;
        // Any other UI event means a device is talking to us: the no-device
        // timer must not cancel the request it is now part of. (After a
        // late plug-in Connect picks the device itself and never re-sends
        // SELECT_DEVICE.)
        if (!noDevice) { stopNoDeviceTimer(); clearTimeout(unacquiredTimer); }
        if (type === UI.REQUEST_BUTTON) {
          emit('Confirm on your Trezor');
        } else if (type === UI.SELECT_DEVICE) {
          if (!noDevice) {
            TrezorConnect.uiResponse({ type: UI.RECEIVE_DEVICE, payload: { device: payload.devices[0], remember: false } });
          } else {
            // Sent with an empty list while no Trezor is attached; Connect then
            // waits for one, so give the user a while and then give up.
            emit('Plug in and unlock your Trezor');
            stopNoDeviceTimer();
            noDeviceTimer = setTimeout(() => {
              cancelReason = new TrezorError('No Trezor found - plug it in and unlock it, then try again.', 'NO_DEVICE');
              TrezorConnect.cancel('Device_NotFound');
            }, NO_DEVICE_WAIT_MS);
          }
        } else if (type === UI.REQUEST_THP_PAIRING) {
          answerPairing(TrezorConnect, UI);
        } else if (type === UI.REQUEST_PASSPHRASE) {
          // Standard wallet only (useEmptyPassphrase), so this should not come up.
          TrezorConnect.uiResponse({ type: UI.RECEIVE_PASSPHRASE, payload: { value: '', passphraseOnDevice: false, save: true } });
        } else if (type === UI.REQUEST_PASSPHRASE_ON_DEVICE) {
          emit('Enter your passphrase on the Trezor');
        } else if (type === UI.REQUEST_PIN) {
          // Trezor One asks for the PIN on the computer: not supported here.
          cancelReason = new TrezorError('This Trezor enters its PIN on the computer, which Noat Boat does not support. Use a Trezor that takes the PIN on the device (Model T, Safe 3/5/7).', 'PIN_ON_COMPUTER');
          TrezorConnect.cancel('PIN entry on the computer is not supported');
        } else if (type === UI.REQUEST_PERMISSION) {
          TrezorConnect.uiResponse({ type: UI.RECEIVE_PERMISSION, payload: { granted: true, remember: true } });
        } else if (type === UI.REQUEST_CONFIRMATION) {
          TrezorConnect.uiResponse({ type: UI.RECEIVE_CONFIRMATION, payload: true });
        }
      });
      TrezorConnect.on(DEVICE_EVENT, (event) => {
        const type = event && event.type;
        const payload = event && event.payload;
        if (type === DEVICE.CONNECT) { stopNoDeviceTimer(); clearTimeout(unacquiredTimer); }
        if (type === DEVICE.CONNECT_UNACQUIRED) {
          // Fires briefly while Connect itself is taking the device over; only
          // worth telling the user if it is still unacquired a moment later.
          clearTimeout(unacquiredTimer);
          unacquiredTimer = setTimeout(() => emit('The Trezor is in use by another app - close Trezor Suite and try again'), 2500);
        }
        if (type === DEVICE.THP_CREDENTIALS_CHANGED && payload && payload.credentials && credentialStore) {
          // Pairing done: keep the host key and the credential for next time.
          try {
            const cur = storedCredentials();
            const known = cur.knownCredentials.filter(c => c && c.credential !== payload.credentials.credential);
            known.push(payload.credentials);
            credentialStore.set({ staticKey: payload.staticKey || cur.staticKey, knownCredentials: known.slice(-8) });
          } catch (e) {
            console.warn('Could not store the Trezor pairing:', e.message);
          }
        }
      });
      const creds = storedCredentials();
      await TrezorConnect.init({
        manifest: { appName: 'Noat Boat', appUrl: 'https://github.com/noatboat', email: 'noatboat@localhost' },
        transports: ['BridgeTransport', 'NodeUsbTransport'],
        trustedHost: true,
        lazyLoad: false,
        popup: false,
        transportReconnect: true,
        thp: {
          hostName: os.hostname(),
          appName: 'Noat Boat',
          pairingMethods: ['CodeEntry'],
          staticKey: creds.staticKey,
          knownCredentials: creds.knownCredentials
        }
      });
      connect = TrezorConnect;
      return connect;
    })().catch((e) => {
      // Drop the half-initialised core and its listeners so the next attempt
      // starts clean instead of double-registering or hitting
      // Init_AlreadyInitialized.
      try { require('@trezor/connect').default.dispose(); } catch (_e) {}
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}

function fail(res) {
  const err = (res && res.payload && res.payload.error) || 'Trezor request failed';
  const code = (res && res.payload && res.payload.code) || '';
  if (cancelReason) throw cancelReason;
  if (/Device_ThpPairingTagInvalid/.test(code) || /pairing tag/i.test(err)) {
    throw new TrezorError('That code did not match what the Trezor showed - try again.', 'PAIRING_CODE');
  }
  if (/Device_ThpPairingMethodsException/.test(code)) {
    throw new TrezorError('This Trezor offers no pairing method Noat Boat supports (it needs code entry).', 'PAIRING_UNSUPPORTED');
  }
  if (/cancel/i.test(err) || /Failure_ActionCancelled|Method_Cancel/.test(code)) {
    throw new TrezorError('Cancelled on the Trezor', 'CANCELLED');
  }
  if (/no device|device not found|Device_NotFound/i.test(err + code)) {
    throw new TrezorError('No Trezor found - plug it in and unlock it, then try again.', 'NO_DEVICE');
  }
  throw new TrezorError(err, code || 'FAILED');
}

// Runs fn(connect) with the callbacks wired up, one request at a time.
function withEvents(onEvent, onPrompt, fn) {
  const run = async () => {
    onEventCb = onEvent || null;
    onPromptCb = onPrompt || null;
    cancelReason = null;
    try {
      return await fn(await getConnect());
    } finally {
      onEventCb = null;
      onPromptCb = null;
      stopNoDeviceTimer();
      clearTimeout(unacquiredTimer);
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

// Model name and label for the slot's display name.
async function describe(onEvent, onPrompt) {
  return withEvents(onEvent, onPrompt, async (tc) => {
    const res = await tc.getFeatures();
    if (!res.success) fail(res);
    const f = res.payload || {};
    const model = f.model === 'T' || f.model === '1' ? `Trezor Model ${f.model}` : `Trezor ${f.internal_model || f.model || ''}`.trim();
    return { label: f.label ? `${model} (${f.label})` : model, deviceId: f.device_id ? `trezor-${f.device_id}` : null };
  });
}

// Deterministic 32-byte secret for nonce (32 bytes).
async function cipher(nonce, onEvent, onPrompt) {
  if (!nonce || nonce.length % 16 !== 0) throw new Error('Nonce must be a multiple of 16 bytes');
  return withEvents(onEvent, onPrompt, async (tc) => {
    emit('Waiting for your Trezor...');
    const res = await tc.cipherKeyValue({
      path: PATH,
      key: PROMPT,
      value: Buffer.from(nonce).toString('hex'),
      encrypt: true,
      askOnEncrypt: true,
      askOnDecrypt: true,
      useEmptyPassphrase: true
    });
    if (!res.success) fail(res);
    return Buffer.from(res.payload.value, 'hex');
  });
}

async function dispose() {
  stopNoDeviceTimer();
  if (connect) { try { connect.dispose(); } catch (_e) {} }
  connect = null;
  initPromise = null;
}

module.exports = { TrezorError, setCredentialStore, describe, cipher, dispose, PATH, PROMPT, PAIRING_CODE_LEN };
