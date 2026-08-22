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
if [ ! -d node_modules ]; then
  echo "node_modules missing -> running npm install"
  npm install
fi

# Build an arm64-only DMG. The -c.mac.target=dmg override collapses the
# multi-arch target defined in package.json so --arm64 restricts output to a
# single arm64 DMG (otherwise both x64 and arm64 are produced).
npx electron-builder --mac --arm64 -c.mac.target=dmg

echo ""
echo "Done. Artifacts:"
ls -lh dist/*arm64.dmg 2>/dev/null || echo "  (no arm64 dmg found — check output above)"
