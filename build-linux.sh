#!/usr/bin/env bash
# build-linux.sh — builds OxiShell for Linux and packages as .deb
# Requirements: go 1.22+, node 18+, npm, dpkg-deb
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$ROOT/frontend"
SERVER_EMBED="$ROOT/internal/server/dist"
OUT="$ROOT/dist"
VERSION="1.2.1"

echo "╔══════════════════════════════════╗"
echo "║  OXIS build — Linux          ║"
echo "╚══════════════════════════════════╝"

for tool in go node npm dpkg-deb; do
  command -v "$tool" >/dev/null || { echo "ERROR: $tool not found"; exit 1; }
done
echo "✓ Tools: go $(go version|grep -oP 'go\K[\d.]+'), node $(node -v), npm $(npm -v)"

echo ""
echo "→ [1/4] Building frontend..."
cd "$FRONTEND_DIR"
npm install --silent
npm run build
echo "   ✓ frontend/dist/ ready"

echo ""
echo "→ [2/4] Embedding frontend into Go server..."
rm -rf "$SERVER_EMBED"
cp -r "$FRONTEND_DIR/dist" "$SERVER_EMBED"
echo "   ✓ internal/server/dist/ ready"

echo ""
echo "→ [3/4] Compiling Go binary..."
cd "$ROOT"
go mod download
mkdir -p "$OUT"

# BuildCommit — required for the commit-based auto-updater (see
# internal/update/update.go's own doc comment for the full design).
# Falls back to "unknown" if this isn't run inside a git checkout for
# some reason, rather than failing the whole build over it.
BUILD_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"

GOOS=linux GOARCH=amd64 go build \
  -ldflags="-s -w -X github.com/oxis/oxis/internal/update.BuildCommit=$BUILD_COMMIT" \
  -o "$OUT/oxis" \
  ./cmd/oxi

echo "   ✓ dist/oxis ($(du -sh "$OUT/oxis"|cut -f1))"

echo ""
echo "→ [4/4] Building .deb package + a portable tarball..."

DEB_STAGE="$OUT/deb/oxis_${VERSION}_amd64"
rm -rf "$OUT/deb"
mkdir -p "$DEB_STAGE/usr/bin"
mkdir -p "$DEB_STAGE/usr/share/applications"
mkdir -p "$DEB_STAGE/DEBIAN"

cp "$OUT/oxis" "$DEB_STAGE/usr/bin/oxis"
chmod 755 "$DEB_STAGE/usr/bin/oxis"

# Symlink: oxi → oxis
ln -s /usr/bin/oxis "$DEB_STAGE/usr/bin/oxi" 2>/dev/null || true

cat > "$DEB_STAGE/DEBIAN/control" << CTRL
Package: oxis
Version: $VERSION
Section: utils
Priority: optional
Architecture: amd64
Maintainer: OXIS <noreply@oxlaboratory.dev>
Description: OxiShell terminal
 Browser-based local terminal. Starts server on port 1420
 and opens Chrome/Edge in app-mode (frameless desktop feel).
 New tabs open Google search.
CTRL

cat > "$DEB_STAGE/usr/share/applications/oxis.desktop" << DESK
[Desktop Entry]
Name=OxiShell
Comment=Browser-based local terminal
Exec=/usr/bin/oxis
Icon=utilities-terminal
Terminal=false
Type=Application
Categories=System;TerminalEmulator;
StartupWMClass=oxis
DESK

# dpkg installs are non-interactive by design — there's no GUI wizard
# step, and no way to offer an install-location choice the way the
# Windows MSI now does (WixUI_InstallDir, plus a Custom Action that
# only lets the person pick somewhere under their own profile — see
# scripts/build-msi.js). /usr/bin is fixed, standard, and (same
# reasoning as Program Files on Windows before that fix) not writable
# by a regular non-root user — and it's shared, system-wide, across
# every account on the machine besides, which is exactly why per-user
# data doesn't belong bundled in there even if it WERE writable.
# OXIS's own write-test in AppDirPath() (internal/wailsapp/app.go)
# already redirects to ~/Downloads/OXIS automatically on Linux for
# that reason, no installer-side change needed — this postinst
# message just says so up front instead of leaving it to be
# discovered. See also the portable tarball built below, for anyone
# who'd rather skip the package manager and dpkg's system-wide
# install location entirely.
cat > "$DEB_STAGE/DEBIAN/postinst" << 'POSTINST'
#!/bin/sh
update-desktop-database /usr/share/applications 2>/dev/null || true
echo
echo 'OXIS installed to /usr/bin/oxis.'
echo 'Its own data (workspaces, plugins, documents) will live under'
echo '~/Downloads/OXIS the first time you run it -- /usr/bin is a shared,'
echo 'system-wide location a regular user account cannot write to, same'
echo 'as the Windows install choosing somewhere under your own user'
echo 'profile instead of Program Files.'
echo
exit 0
POSTINST
chmod 755 "$DEB_STAGE/DEBIAN/postinst"

dpkg-deb --build --root-owner-group "$DEB_STAGE" "$OUT/deb/oxis_${VERSION}_amd64.deb"

# Portable tarball — extract-and-run, everything pre-created, no
# package manager, no /usr/bin, no waiting on the app's own first-run
# git clone. This is the direct Linux equivalent of the Windows
# portable dist/ folder people have been extracting and running all
# along (see README's own clean-install docs), just built fresh here
# rather than left to the app to assemble piece by piece at runtime.
echo ""
echo "→ Building portable tarball..."
PORTABLE_DIR="$OUT/oxis-portable"
rm -rf "$PORTABLE_DIR"
mkdir -p "$PORTABLE_DIR/workspaces" "$PORTABLE_DIR/created-plugins" "$PORTABLE_DIR/created-documents"
cp "$OUT/oxis" "$PORTABLE_DIR/oxis"
chmod 755 "$PORTABLE_DIR/oxis"
tar -czf "$OUT/oxis-${VERSION}-linux-portable.tar.gz" -C "$OUT" oxis-portable
rm -rf "$PORTABLE_DIR"

echo ""
echo "╔══════════════════════════════════╗"
echo "║  Build complete!                 ║"
echo "╚══════════════════════════════════╝"
echo ""
echo "  Binary  : dist/oxis"
echo "  Package : dist/deb/oxis_${VERSION}_amd64.deb"
echo "  Portable: dist/oxis-${VERSION}-linux-portable.tar.gz"
echo ""
echo "  Install (apt/dpkg):  sudo dpkg -i dist/deb/oxis_${VERSION}_amd64.deb && oxis"
echo "  Or portable:         tar xzf dist/oxis-${VERSION}-linux-portable.tar.gz && ./oxis-portable/oxis"
echo "  Or run in place:     ./dist/oxis"