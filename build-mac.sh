#!/usr/bin/env bash
#
# One-command macOS build for this machine (arm64 / Apple Silicon).
#
# This project's toolchain (electron-builder 24 / @electron/rebuild 3.6) breaks
# under the default Homebrew Node (currently v26), so we force Node 20 here.
# Install it once with:  brew install node@20
#
set -euo pipefail

NODE20_BIN="/opt/homebrew/opt/node@20/bin"
if [ ! -x "$NODE20_BIN/node" ]; then
  echo "ERROR: Node 20 not found at $NODE20_BIN" >&2
  echo "Install it with:  brew install node@20" >&2
  exit 1
fi
export PATH="$NODE20_BIN:$PATH"

echo "Using node $(node -v) / npm $(npm -v)"

# Ensure deps + native modules are present/rebuilt for the current Electron.
# Re-run npm install whenever the lockfile changed (e.g. after a merge added deps).
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "dependencies changed -> running npm install"
  # The postinstall `@electron/rebuild` fails on `usb` (pulled in by
  # @trezor/connect): it forces -std=c++14 but its node-addon-api needs C++17.
  # usb and node-hid ship N-API prebuilds for darwin-arm64, which work in any
  # Electron, so on failure rebuild only the modules that need compiling.
  if ! npm install; then
    echo "postinstall rebuild failed -> rebuilding only non-prebuilt native modules"
    rm -rf node_modules/usb/build
    npx @electron/rebuild -f -o blake-hash,tiny-secp256k1
  fi
fi

# Build an arm64-only DMG. The -c.mac.target=dmg override collapses the
# multi-arch target defined in package.json so --arm64 restricts output to a
# single arm64 DMG (otherwise both x64 and arm64 are produced).
#   -c.npmRebuild=false  native modules are already prepared above; letting
#                        electron-builder rebuild would recompile usb and fail.
#   -c.asar=false        electron-builder 24's asar writer drops any folder named
#                        "constructor" (plain-object key collision), which breaks
#                        @sinclair/typebox and therefore @trezor/connect.
npx electron-builder --mac --arm64 -c.mac.target=dmg -c.npmRebuild=false -c.asar=false

echo ""
echo "Done. Artifacts:"
ls -lh dist/*arm64.dmg 2>/dev/null || echo "  (no arm64 dmg found — check output above)"
