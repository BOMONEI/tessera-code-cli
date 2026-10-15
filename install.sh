#!/usr/bin/env bash
# tessera-code installer.
#
#   curl -fsSL https://raw.githubusercontent.com/BOMONEI/tessera-code-cli/main/install.sh | bash
#
# Installs the latest release (or TESSERA_VERSION=0.3.0) from GitHub Releases with npm. Running it again updates.
# Requires Node.js 22+ and npm. The package has no dependencies to download: everything is bundled.
set -euo pipefail

REPO="${TESSERA_REPO:-BOMONEI/tessera-code-cli}"
VERSION="${TESSERA_VERSION:-latest}"
# Where release files are downloaded from (a mirror, or a local server for testing); needs TESSERA_VERSION.
DOWNLOAD_BASE="${TESSERA_DOWNLOAD_BASE:-}"

say() { printf '%s\n' "$*"; }
fail() { printf 'tessera-code install: %s\n' "$*" >&2; exit 1; }

# --- Node.js 22+ and npm ------------------------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js 22 or newer is required, and node was not found.
  Install it first, e.g. with nvm:
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
    nvm install 22
  or from https://nodejs.org, then run this installer again."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "Node.js 22 or newer is required (found $(node -v)). With nvm: nvm install 22 && nvm alias default 22"
fi
command -v npm >/dev/null 2>&1 || fail "npm was not found (it normally comes with Node.js)."
command -v curl >/dev/null 2>&1 || fail "curl was not found."

# --- Which version --------------------------------------------------------------------------------------------------
if [ "$VERSION" = "latest" ]; then
  [ -z "$DOWNLOAD_BASE" ] || fail "TESSERA_DOWNLOAD_BASE needs TESSERA_VERSION"
  # The /releases/latest page redirects to /releases/tag/vX.Y.Z (no API rate limit).
  LATEST_URL="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" ||
    fail "could not reach https://github.com/$REPO/releases/latest"
  TAG="${LATEST_URL##*/}"
  case "$TAG" in v[0-9]*) ;; *) fail "no release found at https://github.com/$REPO/releases" ;; esac
else
  TAG="v${VERSION#v}"
fi
VER="${TAG#v}"
BASE="${DOWNLOAD_BASE:-https://github.com/$REPO/releases/download/$TAG}"
TARBALL="tessera-code-$VER.tgz"

# --- Download and verify --------------------------------------------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say "Downloading tessera-code $VER ..."
curl -fsSL -o "$TMP/$TARBALL" "$BASE/$TARBALL" || fail "download failed: $BASE/$TARBALL"
curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS" || fail "download failed: $BASE/SHA256SUMS"

EXPECTED="$(awk -v f="$TARBALL" '$2 == f || $2 == "*" f { print $1 }' "$TMP/SHA256SUMS")"
[ -n "$EXPECTED" ] || fail "SHA256SUMS has no entry for $TARBALL"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TMP/$TARBALL" | awk '{ print $1 }')"
else
  ACTUAL="$(shasum -a 256 "$TMP/$TARBALL" | awk '{ print $1 }')"
fi
[ "$ACTUAL" = "$EXPECTED" ] || fail "checksum mismatch for $TARBALL (expected $EXPECTED, got $ACTUAL); nothing was installed."

# --- Install --------------------------------------------------------------------------------------------------------
# A global npm prefix the user cannot write to (e.g. /usr/local with the system Node) would need sudo; install under
# ~/.local instead and say how to put it on PATH.
PREFIX_ARG=""
NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
if [ -z "$NPM_PREFIX" ] || ! { [ -w "$NPM_PREFIX/lib" ] || { [ ! -e "$NPM_PREFIX/lib" ] && [ -w "$NPM_PREFIX" ]; }; }; then
  NPM_PREFIX="$HOME/.local"
  mkdir -p "$NPM_PREFIX"
  PREFIX_ARG="--prefix=$NPM_PREFIX"
fi
say "Installing into $NPM_PREFIX ..."
# (No arrays: bash 3.2, the macOS default, fails on an empty one under set -u.)
if [ -n "$PREFIX_ARG" ]; then
  npm install -g "$PREFIX_ARG" --no-fund --no-audit --no-update-notifier --loglevel=error "$TMP/$TARBALL" >/dev/null || fail "npm install failed."
else
  npm install -g --no-fund --no-audit --no-update-notifier --loglevel=error "$TMP/$TARBALL" >/dev/null || fail "npm install failed."
fi

BIN="$NPM_PREFIX/bin/tessera-code"
say ""
say "✓ tessera-code $VER installed: $BIN"
case ":$PATH:" in
  *":$NPM_PREFIX/bin:"*) ;;
  *)
    say ""
    say "  $NPM_PREFIX/bin is not on your PATH. Add it, e.g.:"
    say "    echo 'export PATH=\"$NPM_PREFIX/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
    ;;
esac
say ""
say "Next:"
say "  tessera-code            start it in a project folder"
say "  /auth <your-key>        register your OpenCode Go API key (once)"
say ""
say "Update: tessera-code update (or run this installer again).  Remove: npm uninstall -g ${PREFIX_ARG:+$PREFIX_ARG }tessera-code"
