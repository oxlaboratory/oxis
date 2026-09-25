#!/usr/bin/env bash
# build-linux.sh — builds OXIS for Linux: binary, .deb and portable tarball.
# Requirements: go 1.22+, node 24+, npm, dpkg-deb, pkg-config,
# libgtk-3-dev and libwebkit2gtk-4.1-dev (or 4.0-dev).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$ROOT/frontend"
SERVER_EMBED="$ROOT/internal/server/dist"
OUT="$ROOT/dist"
VERSION="$(node -p "require('$ROOT/package.json').version")"

echo "→ OXIS $VERSION — Linux build"

for tool in go node npm dpkg-deb pkg-config; do
  command -v "$tool" >/dev/null || { echo "ERROR: $tool not found"; exit 1; }
done

# Wails needs WebKitGTK. Ubuntu 24.04+ only ships 4.1, which needs the
# webkit2_41 build tag.
TAGS="desktop,production"
if pkg-config --exists webkit2gtk-4.1; then
  TAGS="$TAGS,webkit2_41"
  WEBKIT_DEP="libwebkit2gtk-4.1-0"
elif pkg-config --exists webkit2gtk-4.0; then
  WEBKIT_DEP="libwebkit2gtk-4.0-37"
else
  echo "ERROR: WebKitGTK not found — install libwebkit2gtk-4.1-dev (or 4.0-dev) and libgtk-3-dev"
  exit 1
fi

echo ""
echo "→ [1/4] Building frontend..."
cd "$FRONTEND_DIR"
npm install --silent
npm run build

echo ""
echo "→ [2/4] Embedding frontend..."
rm -rf "$SERVER_EMBED"
cp -r "$FRONTEND_DIR/dist" "$SERVER_EMBED"

echo ""
echo "→ [3/4] Compiling Go binary (tags: $TAGS)..."
cd "$ROOT"
go mod download
mkdir -p "$OUT"
BUILD_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo "")"
go build -tags "$TAGS" \
  -ldflags="-s -w -X github.com/oxis/oxis/internal/wailsapp.Version=$VERSION -X github.com/oxis/oxis/internal/update.BuildCommit=$BUILD_COMMIT" \
  -o "$OUT/oxis" \
  ./cmd/oxi
echo "   ✓ dist/oxis ($(du -sh "$OUT/oxis" | cut -f1))"

echo ""
echo "→ [4/4] Packaging..."
DEB_STAGE="$OUT/deb/oxis_${VERSION}_amd64"
rm -rf "$OUT/deb"
mkdir -p "$DEB_STAGE/usr/bin" \
         "$DEB_STAGE/usr/share/applications" \
         "$DEB_STAGE/usr/share/icons/hicolor/256x256/apps" \
         "$DEB_STAGE/DEBIAN"

install -m 755 "$OUT/oxis" "$DEB_STAGE/usr/bin/oxis"
ln -s /usr/bin/oxis "$DEB_STAGE/usr/bin/oxi"
if [ -f "$FRONTEND_DIR/public/logo.png" ]; then
  cp "$FRONTEND_DIR/public/logo.png" "$DEB_STAGE/usr/share/icons/hicolor/256x256/apps/oxis.png"
fi

cat > "$DEB_STAGE/DEBIAN/control" << CTRL
Package: oxis
Version: $VERSION
Section: utils
Priority: optional
Architecture: amd64
Depends: libgtk-3-0, $WEBKIT_DEP
Maintainer: OXIS <noreply@oxlaboratory.dev>
Homepage: https://github.com/oxlaboratory/oxis
Description: OXIS — Open Xenial Intelligent Shell
 A native desktop terminal with Lua plugins, workspaces and a
 built-in editor.
CTRL

cat > "$DEB_STAGE/usr/share/applications/oxis.desktop" << DESK
[Desktop Entry]
Name=OXIS
Comment=Open Xenial Intelligent Shell
Exec=/usr/bin/oxis
Icon=oxis
Terminal=false
Type=Application
Categories=System;TerminalEmulator;
StartupWMClass=oxis
DESK

# /usr/bin isn't user-writable, so OXIS keeps its data in ~/Downloads/OXIS
# (see AppDirPath in internal/wailsapp/app.go).
cat > "$DEB_STAGE/DEBIAN/postinst" << 'POSTINST'
#!/bin/sh
update-desktop-database /usr/share/applications 2>/dev/null || true
gtk-update-icon-cache /usr/share/icons/hicolor 2>/dev/null || true
echo
echo 'OXIS installed to /usr/bin/oxis.'
echo 'Workspaces, plugins and documents are stored in ~/Downloads/OXIS.'
echo
exit 0
POSTINST
chmod 755 "$DEB_STAGE/DEBIAN/postinst"

dpkg-deb --build --root-owner-group "$DEB_STAGE" "$OUT/deb/oxis_${VERSION}_amd64.deb"

# Portable tarball: extract and run, data stays next to the binary.
PORTABLE_DIR="$OUT/oxis-portable"
rm -rf "$PORTABLE_DIR"
mkdir -p "$PORTABLE_DIR/workspaces" "$PORTABLE_DIR/created-plugins" "$PORTABLE_DIR/created-documents"
install -m 755 "$OUT/oxis" "$PORTABLE_DIR/oxis"
tar -czf "$OUT/oxis-${VERSION}-linux-portable.tar.gz" -C "$OUT" oxis-portable
rm -rf "$PORTABLE_DIR"

echo ""
echo "✓ Build complete"
echo "  Binary  : dist/oxis"
echo "  Package : dist/deb/oxis_${VERSION}_amd64.deb"
echo "  Portable: dist/oxis-${VERSION}-linux-portable.tar.gz"
