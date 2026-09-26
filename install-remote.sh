#!/bin/sh
# Remote installer for zh (headless zcode).
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/coderbuzz/zheadless/main/install-remote.sh | sh
#
# Methods (user's choice):
#   binary  standalone per-OS/arch executable; no bun/node needed  (default)
#   bundle  dist/zcode.cjs + launcher; runs with bun, falls back to node
#   source  full source checkout built locally; needs bun
#
# Usage:
#   install-remote.sh [--method=binary|bundle|source] [--version=TAG]
#                     [--home=DIR] [--prefix=DIR] [--asset-dir=DIR]
#                     [--no-verify] [--uninstall]
#
# --asset-dir loads prebuilt assets from a local directory (offline/dev runs).
set -eu

REPO="coderbuzz/zheadless"
DEFAULT_HOME="$HOME/.local/share/zheadless"
DEFAULT_PREFIX="$HOME/.local/bin"

METHOD=""
WANT_VERSION=""
INSTALL_HOME="$DEFAULT_HOME"
PREFIX="$DEFAULT_PREFIX"
ASSET_DIR=""
NO_VERIFY=0

for arg in "$@"; do
  case $arg in
    --method=*) METHOD=${arg#--method=} ;;
    --version=*) WANT_VERSION=${arg#--version=} ;;
    --home=*) INSTALL_HOME=${arg#--home=} ;;
    --prefix=*) PREFIX=${arg#--prefix=} ;;
    --asset-dir=*) ASSET_DIR=${arg#--asset-dir=} ;;
    --no-verify) NO_VERIFY=1 ;;
    --uninstall) METHOD="uninstall" ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

LINK="$PREFIX/zh"

if [ "$METHOD" = "uninstall" ]; then
  if [ -L "$LINK" ]; then
    target_dir=$(cd "$(dirname "$(readlink "$LINK")")" 2>/dev/null && pwd)
    rm "$LINK"
    echo "removed $LINK"
  else
    target_dir=""
    echo "no launcher at $LINK"
  fi
  if [ -f "$INSTALL_HOME/.zheadless-install" ]; then
    rm -rf "$INSTALL_HOME"
    echo "removed $INSTALL_HOME"
  elif [ -n "$target_dir" ]; then
    echo "note: install root $INSTALL_HOME not found or not managed; left untouched"
  fi
  exit 0
fi

say() { printf '\n== %s\n' "$1"; }

fetch() { # fetch <url> <outfile>
  if [ -n "$ASSET_DIR" ]; then
    cp "$ASSET_DIR/$1" "$2"
  else
    curl -fSL --retry 3 -o "$2" "$1"
  fi
}

fetch_stdout() { # fetch_stdout <url>
  if [ -n "$ASSET_DIR" ]; then
    cat "$ASSET_DIR/$1"
  else
    curl -fsSL --retry 3 "$1"
  fi
}

# --- resolve release tag -----------------------------------------------------
# source builds can proceed without a tag (falls back to the main branch tarball).
if [ -z "$WANT_VERSION" ] && [ -z "$ASSET_DIR" ] && [ "$METHOD" != "source" ]; then
  say "resolving latest release"
  WANT_VERSION=$(fetch_stdout "https://api.github.com/repos/$REPO/releases/latest" |
    grep -m1 '"tag_name"' | cut -d'"' -f4) || WANT_VERSION=""
  [ -n "$WANT_VERSION" ] || { echo "cannot resolve latest release tag" >&2; exit 1; }
fi
TAG="$WANT_VERSION"
echo "release: ${TAG:-local assets}"

# --- platform ----------------------------------------------------------------
OS=$(uname -s)
ARCH=$(uname -m)
case $OS in
  Linux) OS_TAG="linux" ;;
  Darwin) OS_TAG="darwin" ;;
  *) echo "unsupported OS: $OS (binary assets cover linux/darwin; use --method=bundle)" >&2; exit 1 ;;
esac
case $ARCH in
  x86_64 | amd64) ARCH_TAG="x64" ;;
  arm64 | aarch64) ARCH_TAG="arm64" ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac

# --- method ------------------------------------------------------------------
if [ -z "$METHOD" ]; then
  METHOD="bundle"
  if [ -z "$ASSET_DIR" ]; then
    if fetch_stdout "https://api.github.com/repos/$REPO/releases/$TAG" |
      grep -q "zh-$TAG-$OS_TAG-$ARCH_TAG.tar.gz"; then
      METHOD="binary"
    fi
  elif [ -f "$ASSET_DIR/zh-$TAG-$OS_TAG-$ARCH_TAG.tar.gz" ]; then
    METHOD="binary"
  fi
fi
echo "method: $METHOD"

BASE_URL="https://github.com/$REPO/releases/download/$TAG"
if [ -n "$ASSET_DIR" ] && [ "$METHOD" != "source" ]; then
  mkdir -p "$ASSET_DIR"
fi

download_asset() { # download_asset <name> <dest>
  echo "downloading $1"
  fetch "$1" "$2"
  if [ "$NO_VERIFY" = "0" ]; then
    SUMS=$(mktemp)
    fetch "SHA256SUMS" "$SUMS"
    expected=$(grep "  $1\$" "$SUMS" | awk '{print $1}')
    rm -f "$SUMS"
    [ -n "$expected" ] || { echo "no checksum entry for $1" >&2; exit 1; }
    if command -v sha256sum >/dev/null 2>&1; then
      actual=$(sha256sum "$2" | awk '{print $1}')
    else
      actual=$(shasum -a 256 "$2" | awk '{print $1}')
    fi
    [ "$actual" = "$expected" ] || { echo "checksum mismatch for $1" >&2; exit 1; }
    echo "checksum OK"
  fi
}

case $METHOD in
  binary)
    ASSET="zh-$TAG-$OS_TAG-$ARCH_TAG.tar.gz"
    say "installing standalone binary ($OS_TAG-$ARCH_TAG)"
    TMP=$(mktemp -d)
    download_asset "$ASSET" "$TMP/$ASSET"
    rm -rf "$INSTALL_HOME"
    mkdir -p "$INSTALL_HOME"
    tar -xzf "$TMP/$ASSET" -C "$INSTALL_HOME"
    rm -rf "$TMP"
    ;;
  bundle)
    ASSET="zheadless-bundle-$TAG.tar.gz"
    say "installing bundle (runs on bun, falls back to node)"
    TMP=$(mktemp -d)
    download_asset "$ASSET" "$TMP/$ASSET"
    rm -rf "$INSTALL_HOME"
    mkdir -p "$INSTALL_HOME"
    tar -xzf "$TMP/$ASSET" -C "$INSTALL_HOME"
    rm -rf "$TMP"
    ;;
  source)
    say "installing from source (requires bun; will be installed if missing)"
    if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/bun" ]; then
      echo "installing bun..."
      curl -fsSL https://bun.sh/install | sh
    fi
    PATH="$HOME/.bun/bin:$PATH"
    command -v bun >/dev/null 2>&1 || { echo "bun unavailable" >&2; exit 1; }
    VERSION_REF=${TAG:-main}
    SRC_TARBALL="zheadless-$VERSION_REF.tar.gz"
    TMP=$(mktemp -d)
    if [ -n "$ASSET_DIR" ] && [ -f "$ASSET_DIR/$SRC_TARBALL" ]; then
      cp "$ASSET_DIR/$SRC_TARBALL" "$TMP/$SRC_TARBALL"
    else
      fetch "https://github.com/$REPO/archive/refs/tags/$VERSION_REF.tar.gz" "$TMP/$SRC_TARBALL" ||
        fetch "https://github.com/$REPO/archive/refs/heads/main.tar.gz" "$TMP/$SRC_TARBALL"
    fi
    rm -rf "$INSTALL_HOME"
    mkdir -p "$INSTALL_HOME"
    tar -xzf "$TMP/$SRC_TARBALL" -C "$INSTALL_HOME" --strip-components 1
    rm -rf "$TMP"
    (cd "$INSTALL_HOME" && bun install --frozen-lockfile && sh build-all.sh)
    ;;
  *)
    echo "unknown method: $METHOD" >&2
    exit 2
    ;;
esac

echo "zheadless-install: method=$METHOD version=${TAG:-local} date=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$INSTALL_HOME/.zheadless-install"

# --- symlink -----------------------------------------------------------------
mkdir -p "$PREFIX"
LAUNCH_TARGET="$INSTALL_HOME/bin/zh"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  echo "refusing to overwrite non-symlink $LINK (remove it or pass --prefix)" >&2
  exit 1
fi
ln -sfn "$LAUNCH_TARGET" "$LINK"
echo "installed: $LINK -> $LAUNCH_TARGET"

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "note: $PREFIX is not in PATH; add it to your shell profile." ;;
esac

# --- smoke test ---------------------------------------------------------------
if "$LINK" version >/dev/null 2>&1; then
  say "smoke test OK: zh version -> $("$LINK" version 2>/dev/null || true)"
  echo "done. try: zh -p \"list the files in this directory\""
else
  echo "warning: smoke test failed; run 'zh version' to inspect." >&2
  exit 1
fi
