#!/usr/bin/env bash
#
# Integrate the latest Windows dev branch (experiments) into this mac branch,
# then build the macOS app. One-directional: experiments -> mac. Never touches
# main or experiments.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 1. Must be on the mac branch, with a clean working tree.
current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_branch" != "mac" ]; then
  echo "ERROR: you are on '$current_branch', not 'mac'." >&2
  echo "Run:  git checkout mac" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree has uncommitted changes. Commit or stash them first." >&2
  git status --short >&2
  exit 1
fi

# 2. Get the latest experiments from the remote.
echo "==> Fetching latest from origin..."
git fetch origin

# 3. Show what's about to be integrated.
incoming="$(git log --oneline mac..origin/experiments)"
if [ -z "$incoming" ]; then
  echo "==> mac is already up to date with origin/experiments. Nothing to merge."
else
  echo "==> Integrating these commits from experiments:"
  echo "$incoming"
  echo ""
  if ! git merge origin/experiments; then
    echo "" >&2
    echo "ERROR: merge conflict. Resolve the conflicts, then run:" >&2
    echo "  git add <file>" >&2
    echo "  git commit" >&2
    echo "  git push origin mac" >&2
    echo "  ./build-mac.sh" >&2
    exit 1
  fi
  # 4. Back up the updated mac branch.
  echo "==> Pushing updated mac branch to origin..."
  git push origin mac
fi

# 5. Build.
echo "==> Building macOS app..."
./build-mac.sh
