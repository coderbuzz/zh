#!/bin/sh
# Install zh (headless zcode) for console use:
#   1. ensure bun (priority runtime)
#   2. bun install + build workspace packages
#   3. symlink bin/zh into ~/.local/bin (or $PREFIX/bin)
#
# Usage:
#   sh install.sh              install or repair
#   sh install.sh --uninstall  remove the zh symlink
set -eu

ROOT=$(cd "$(dirname "$0")" && pwd)
PREFIX="${PREFIX:-$HOME/.local/bin}"
LINK="$PREFIX/zh"

if [ "${1:-}" = "--uninstall" ]; then
  if [ -L "$LINK" ]; then
    rm "$LINK"
    echo "removed $LINK"
  else
    echo "no symlink at $LINK (nothing to uninstall)"
  fi
  exit 0
fi

# --- bun -------------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/bun" ]; then
  echo "bun not found; installing..."
  curl -fsSL https://bun.sh/install | bash
fi
PATH="$HOME/.bun/bin:$PATH"
command -v bun >/dev/null 2>&1 || {
  echo "error: bun is still unavailable after install." >&2
  exit 1
}
echo "bun: $(bun --version)"

# --- dependencies + build ---------------------------------------------------
cd "$ROOT"
echo "installing dependencies..."
bun install --frozen-lockfile
echo "building workspace packages..."
sh build-all.sh

# --- launcher symlink --------------------------------------------------------
chmod +x "$ROOT/bin/zh"
mkdir -p "$PREFIX"
ln -sfn "$ROOT/bin/zh" "$LINK"
echo "installed: $LINK -> $ROOT/bin/zh"

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "note: $PREFIX is not in PATH; add it to your shell profile." ;;
esac

# --- smoke test --------------------------------------------------------------
if "$LINK" version >/dev/null 2>&1; then
  echo "smoke test OK: zh version -> $("$LINK" version 2>/dev/null || true)"
  echo "done. try: zh -p \"list the files in this directory\""
else
  echo "warning: smoke test failed; run 'zh version' to inspect." >&2
  exit 1
fi
