#!/bin/sh
# Remote installer for zh (headless zcode).
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/coderbuzz/zh/main/install-remote.sh | sh
#
# Methods:
#   auto    pick the smallest install that runs on this machine: bundle when a
#           usable runtime is already present (bun, or node >= 22; the runtime
#           contract of dist/zcode.cjs), binary otherwise            (default)
#   binary  standalone per-OS/arch executable; no bun/node needed
#   bundle  dist/zcode.cjs + launcher; runs with bun, falls back to node
#   source  full source checkout built locally; needs bun
#
# In bundle mode the launcher resolves bun/node itself; when the validated
# runtime lives outside the default PATH (version managers, ~/.bun before the
# profile reload), the installer records its absolute path in
# <install root>/.zh-runtime so `zh` finds it in non-interactive shells too.
#
# Usage:
#   install-remote.sh [--method=auto|binary|bundle|source] [--version=TAG]
#                     [--home=DIR] [--prefix=DIR] [--asset-dir=DIR]
#                     [--no-verify] [--no-browser-driver] [--web] [--uninstall]
#
# --asset-dir loads prebuilt assets from a local directory (offline/dev runs).
# --web adds the zh web mode runtime (web UI + Node server); it needs Node >= 22
# at runtime (node-pty native addon) and is available for binary/bundle installs.
set -eu

REPO="coderbuzz/zh"
DEFAULT_HOME="$HOME/.local/share/zh"
LEGACY_HOME="$HOME/.local/share/zheadless" # install root before the repo rename
DEFAULT_PREFIX="$HOME/.local/bin"

METHOD=""
WANT_VERSION=""
INSTALL_HOME="$DEFAULT_HOME"
PREFIX="$DEFAULT_PREFIX"
ASSET_DIR=""
NO_VERIFY=0
NO_BROWSER_DRIVER=0
WEB_INSTALL=0

for arg in "$@"; do
  case $arg in
    --method=*) METHOD=${arg#--method=} ;;
    --version=*) WANT_VERSION=${arg#--version=} ;;
    --home=*) INSTALL_HOME=${arg#--home=} ;;
    --prefix=*) PREFIX=${arg#--prefix=} ;;
    --asset-dir=*) ASSET_DIR=${arg#--asset-dir=} ;;
    --no-verify) NO_VERIFY=1 ;;
    --no-browser-driver) NO_BROWSER_DRIVER=1 ;;
    --web) WEB_INSTALL=1 ;;
    --uninstall) METHOD="uninstall" ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

LINK="$PREFIX/zh"

# Move a pre-rename install root (~/.local/share/zheadless) to the new default
# and leave a symlink behind so old paths keep resolving. Only for the default
# home; an install root chosen with --home is never touched.
if [ "$INSTALL_HOME" = "$DEFAULT_HOME" ] && [ -d "$LEGACY_HOME" ] && [ ! -L "$LEGACY_HOME" ] && [ ! -e "$DEFAULT_HOME" ]; then
  mv "$LEGACY_HOME" "$DEFAULT_HOME"
  [ -f "$DEFAULT_HOME/.zheadless-install" ] && mv "$DEFAULT_HOME/.zheadless-install" "$DEFAULT_HOME/.zh-install"
  ln -s "$DEFAULT_HOME" "$LEGACY_HOME"
  echo "migrated install root: $LEGACY_HOME -> $DEFAULT_HOME (symlink left at the old path)"
fi

if [ "$METHOD" = "uninstall" ]; then
  if [ -L "$LINK" ]; then
    target_dir=$(cd "$(dirname "$(readlink "$LINK")")" 2>/dev/null && pwd)
    rm "$LINK"
    echo "removed $LINK"
  else
    target_dir=""
    echo "no launcher at $LINK"
  fi
  if [ -f "$INSTALL_HOME/.zh-install" ] || [ -f "$INSTALL_HOME/.zheadless-install" ]; then
    rm -rf "$INSTALL_HOME"
    echo "removed $INSTALL_HOME"
    [ -L "$LEGACY_HOME" ] && rm "$LEGACY_HOME"
  elif [ -n "$target_dir" ]; then
    echo "note: install root $INSTALL_HOME not found or not managed; left untouched"
  fi
  exit 0
fi

say() { printf '\n== %s\n' "$1"; }

fetch() { # fetch <url-or-release-asset-name> <outfile>
  case $1 in
    http*) url=$1 ;;
    *) url="$BASE_URL/$1" ;;
  esac
  if [ -n "$ASSET_DIR" ]; then
    cp "$ASSET_DIR/$(basename "$1")" "$2"
  else
    curl -fSL --retry 3 -o "$2" "$url"
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

# --- runtime detection (auto selection and bundle pinning) --------------------
# Mirrors the bundle runtime contract from packages/cli/scripts/build.mjs:
# dist/zcode.cjs runs on node >= 22 or a current bun; the two executables are
# interchangeable for the prebuilt bundle.
NODE_MIN_MAJOR=22
BUN_MIN_MAJOR=1

path_has_dir() {
  case ":$PATH:" in *":$1:"*) return 0 ;; *) return 1 ;; esac
}

major_of() { # major_of <version output>; accepts "v24.21.0" and "1.4.2"
  printf '%s' "$1" | sed -n 's/^[vV]\{0,1\}\([0-9][0-9]*\).*/\1/p'
}

runtime_ok() { # runtime_ok <absolute bin> <min major>
  [ -n "$1" ] && [ -x "$1" ] || return 1
  RUNTIME_VERSION=$("$1" --version 2>/dev/null) || return 1
  [ "$(major_of "$RUNTIME_VERSION")" -ge "$2" ] 2>/dev/null || return 1
}

detect_bun() { # prints the first usable bun path, or nothing
  if command -v bun >/dev/null 2>&1; then command -v bun; return 0; fi
  for candidate in "$HOME/.bun/bin/bun" /usr/local/bin/bun /opt/homebrew/bin/bun; do
    [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

detect_node() { # prints the newest usable node path, or nothing
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  for candidate in /usr/local/bin/node /usr/bin/node "$HOME/.local/bin/node"; do
    [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$candidate" ] && printf '%s\n' "$candidate"
  done | sort -V | tail -1
}

BUN_BIN_DETECTED=""
NODE_BIN_DETECTED=""
if BUN_CANDIDATE=$(detect_bun) && runtime_ok "$BUN_CANDIDATE" "$BUN_MIN_MAJOR"; then
  BUN_BIN_DETECTED=$BUN_CANDIDATE
fi
if NODE_CANDIDATE=$(detect_node) && runtime_ok "$NODE_CANDIDATE" "$NODE_MIN_MAJOR"; then
  NODE_BIN_DETECTED=$NODE_CANDIDATE
fi

# --- method ------------------------------------------------------------------
if [ -z "$METHOD" ] || [ "$METHOD" = "auto" ]; then
  if [ -n "$BUN_BIN_DETECTED" ] || [ -n "$NODE_BIN_DETECTED" ]; then
    METHOD="bundle"
  elif [ -n "$ASSET_DIR" ]; then
    if [ -f "$ASSET_DIR/zh-$TAG-$OS_TAG-$ARCH_TAG.tar.gz" ]; then
      METHOD="binary"
    else
      echo "auto: no runtime and no binary asset in $ASSET_DIR; install bun or node, or pass --method=bundle" >&2
      exit 1
    fi
  elif [ -n "$TAG" ] && fetch_stdout "https://api.github.com/repos/$REPO/releases/tags/$TAG" |
    grep -q "\"name\": \"zh-$TAG-$OS_TAG-$ARCH_TAG.tar.gz\""; then
    METHOD="binary"
  else
    echo "auto: no usable bun/node found and no binary asset for $OS_TAG-$ARCH_TAG." >&2
    echo "  Install bun (https://bun.sh) or node >= $NODE_MIN_MAJOR, or pass --method=bundle explicitly." >&2
    exit 1
  fi
fi
echo "method: $METHOD"

if [ "$METHOD" = "bundle" ] && [ -z "$BUN_BIN_DETECTED" ] && [ -z "$NODE_BIN_DETECTED" ]; then
  echo "warning: no usable bun/node detected; the bundle needs one (node >= $NODE_MIN_MAJOR) to run." >&2
fi

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

# binary/bundle installs get the playwright-core driver and the TUI runtime as
# separate assets; source installs already have both from bun install.
if [ "$METHOD" = "binary" ] || [ "$METHOD" = "bundle" ]; then
  if [ "$NO_BROWSER_DRIVER" = "0" ] && [ -n "$TAG" ]; then
    say "installing browser driver (playwright-core)"
    DRIVER_TMP=$(mktemp -d)
    download_asset "playwright-core-$TAG.tar.gz" "$DRIVER_TMP/pwc.tar.gz"
    mkdir -p "$INSTALL_HOME/node_modules"
    tar -xzf "$DRIVER_TMP/pwc.tar.gz" -C "$INSTALL_HOME/node_modules"
    rm -rf "$DRIVER_TMP"
  fi
  if [ -n "$TAG" ]; then
    say "installing TUI runtime"
    TUI_TMP=$(mktemp -d)
    download_asset "zheadless-tui-runtime-$TAG.tar.gz" "$TUI_TMP/tui.tar.gz"
    tar -xzf "$TUI_TMP/tui.tar.gz" -C "$INSTALL_HOME"
    rm -rf "$TUI_TMP"
  fi
  if [ "$WEB_INSTALL" = "1" ]; then
    [ -n "$TAG" ] || { echo "--web needs a release tag; use --version=TAG or a default install" >&2; exit 1; }
    say "installing web mode runtime (needs Node >= 22 for zh web)"
    WEB_TMP=$(mktemp -d)
    download_asset "zheadless-web-$TAG.tar.gz" "$WEB_TMP/web.tar.gz"
    tar -xzf "$WEB_TMP/web.tar.gz" -C "$INSTALL_HOME"
    rm -rf "$WEB_TMP"
  fi
fi

# Bundle installs pin the validated runtimes when their directories are not in
# PATH, so the launcher also works in non-interactive shells (cron, agents,
# fresh terminals before the profile reloads). Pinned binaries win over PATH.
if [ "$METHOD" = "bundle" ]; then
  PIN_FILE="$INSTALL_HOME/.zh-runtime"
  : > "$PIN_FILE"
  pin_runtime() { # pin_runtime <BUN|NODE> <absolute bin>
    [ -n "$2" ] || return 0
    path_has_dir "$(dirname "$2")" && return 0
    printf 'ZH_RUNTIME_%s="%s"\n' "$1" "$2" >> "$PIN_FILE"
    echo "pinned $1 runtime: $2 (directory is not in PATH)"
  }
  pin_runtime BUN "$BUN_BIN_DETECTED"
  pin_runtime NODE "$NODE_BIN_DETECTED"
  [ -s "$PIN_FILE" ] || rm -f "$PIN_FILE"
fi

echo "zh-install: method=$METHOD version=${TAG:-local} date=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$INSTALL_HOME/.zh-install"
rm -f "$INSTALL_HOME/.zheadless-install"

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
