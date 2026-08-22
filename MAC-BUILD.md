# macOS build branch (`mac`)

This machine builds the **macOS** version of Noat Boat. The `mac` branch is a
build-only branch: it receives changes **one-directionally** from the Windows
dev branch (`experiments`) and holds mac-only build helpers that must never go
back to `experiments` or `main`.

## One-time setup (already done on this machine)

```bash
brew install node@20    # this toolchain breaks on newer Node; we pin Node 20
```

## Everyday workflow

After you've updated and pushed the Windows branch:

```bash
# 1. (on the Windows dev side) push your work
git push origin experiments

# 2. bring those changes into the mac branch (windows -> mac only)
git checkout mac
git merge experiments        # fast-forwards or a clean merge; resolve conflicts if any

# 3. back up the mac branch to the remote
git push origin mac

# 4. build the macOS app
./build-mac.sh               # -> dist/Noat Boat-<version>-arm64.dmg
```

## Safety

- `main` is only ever changed if you explicitly `git checkout main` and merge into it.
  This workflow never does that — it only merges **from** `experiments` **into** `mac`,
  so `main` and `experiments` are never modified by mac-side work.
- Build artifacts (`dist/`) and `node_modules/` are gitignored, so they are never committed.

## Notes

- The build is **unsigned** (no Apple Developer ID). To run locally after copying,
  users may need: right-click → Open, or `xattr -cr "Noat Boat.app"`.
- `build-mac.sh` builds **arm64 only**. For a universal or Intel build, use the
  package.json scripts (`npm run build-mac` builds both arches) with Node 20 on PATH:
  `export PATH="/opt/homebrew/opt/node@20/bin:$PATH"`.
