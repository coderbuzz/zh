#!/bin/sh
# Regenerate the vendor/upstream branch from a zcode revision and commit it.
#
# vendor/upstream holds verbatim copies of the zcode monorepo files this repo
# ships, laid out exactly like this repo:
#
#   apps/zcode-cli/packages/<pkg>  ->  packages/<pkg>   (APPS_PACKAGES below)
#   packages/<pkg>                 ->  packages/<pkg>   (ROOT_PACKAGES below)
#   config/provider/zcode-builtin.json
#   patches/@ai-sdk__*.patch
#   third-party/, THIRD-PARTY-NOTICES.md
#
# It is written only by this script. Patch the copies on main, never on the
# vendor branch: on every sync, `git merge vendor/upstream` re-applies this
# repo's patch layer three-way and conflicts only where upstream touched the
# same hunks. Tag each synced revision as vendor/vX.Y.Z.
#
# Usage:
#   scripts/sync-vendor.sh <zcode-rev>           update the vendor branch
#   scripts/sync-vendor.sh --orphan <zcode-rev>  recreate it with a root commit
#
# Environment:
#   ZCODE_REPO  zcode clone holding <zcode-rev> (default: ../zcode)
set -eu

VENDOR_BRANCH=vendor/upstream
APPS_PACKAGES="adapters bootstrap cli contracts core dynamic-workflow dynamic-workflow-runtime i18n shared-types telemetry tui"
ROOT_PACKAGES="formal-proof model-option-map provider provider-node shared zcode-cua rpc client services server web"

die() {
  echo "sync-vendor: $*" >&2
  exit 1
}

ORPHAN=0
if [ "${1:-}" = "--orphan" ]; then
  ORPHAN=1
  shift
fi
REV=${1:-}
[ -n "$REV" ] || die "usage: scripts/sync-vendor.sh [--orphan] <zcode-rev>"

REPO=$(git rev-parse --show-toplevel)
ZCODE_REPO=${ZCODE_REPO:-$(dirname "$REPO")/zcode}
[ -d "$ZCODE_REPO" ] || die "zcode clone not found at $ZCODE_REPO (set ZCODE_REPO)"
git -C "$ZCODE_REPO" rev-parse -q --verify "$REV^{commit}" >/dev/null \
  || die "revision $REV not found in $ZCODE_REPO"
FULL_REV=$(git -C "$ZCODE_REPO" rev-parse "$REV^{commit}")
SHORT_REV=$(git -C "$ZCODE_REPO" rev-parse --short "$REV^{commit}")
ZCODE_VERSION=$(git -C "$ZCODE_REPO" show "$REV:package.json" \
  | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -n 1)
[ -n "$ZCODE_VERSION" ] || die "cannot read the version from $REV:package.json"

has_rev_path() {
  git -C "$ZCODE_REPO" rev-parse -q --verify "$REV:$1" >/dev/null 2>&1
}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/zh-vendor.XXXXXX")
SRC="$WORK/src"
WT="$WORK/wt"
cleanup() {
  git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# Extract the mapped source roots at the revision (tracked files only).
mkdir -p "$SRC"
ARCHIVE_PATHS="apps/zcode-cli/packages packages config patches"
if has_rev_path third-party; then
  ARCHIVE_PATHS="$ARCHIVE_PATHS third-party"
fi
if has_rev_path THIRD-PARTY-NOTICES.md; then
  ARCHIVE_PATHS="$ARCHIVE_PATHS THIRD-PARTY-NOTICES.md"
fi
git -C "$ZCODE_REPO" archive "$REV" -- $ARCHIVE_PATHS | tar -x -C "$SRC"

if [ "$ORPHAN" = 1 ]; then
  git -C "$REPO" branch -D "$VENDOR_BRANCH" >/dev/null 2>&1 || true
  git -C "$REPO" worktree add --quiet --detach "$WT"
  git -C "$WT" checkout --orphan "$VENDOR_BRANCH" --quiet
  git -C "$WT" rm -rf --quiet .
else
  git -C "$REPO" rev-parse -q --verify "$VENDOR_BRANCH" >/dev/null \
    || die "branch $VENDOR_BRANCH missing; create it with --orphan first"
  git -C "$REPO" worktree add --quiet "$WT" "$VENDOR_BRANCH"
fi

# Packages. Whole directories, so new upstream files and deletions flow in.
for pkg in $APPS_PACKAGES; do
  if [ -d "$SRC/apps/zcode-cli/packages/$pkg" ]; then
    rsync -a --delete "$SRC/apps/zcode-cli/packages/$pkg/" "$WT/packages/$pkg/"
  else
    echo "NOTICE: apps package '$pkg' no longer exists upstream; dropping the vendored copy" >&2
    rm -rf "$WT/packages/$pkg"
  fi
done
for pkg in $ROOT_PACKAGES; do
  if [ -d "$SRC/packages/$pkg" ]; then
    rsync -a --delete "$SRC/packages/$pkg/" "$WT/packages/$pkg/"
  else
    echo "NOTICE: root package '$pkg' no longer exists upstream; dropping the vendored copy" >&2
    rm -rf "$WT/packages/$pkg"
  fi
done
# The cli and tui bundlers are this repo's own; upstream's esbuild and SEA
# scripts must never enter the vendor branch.
rm -rf "$WT/packages/cli/scripts" "$WT/packages/tui/scripts"

# Bundled provider catalog (main keeps an enriched copy; the vendor copy is
# the upstream reference for manual merges).
mkdir -p "$WT/config/provider"
rm -f "$WT/config/provider/zcode-builtin.json"
if [ -f "$SRC/config/provider/zcode-builtin.json" ]; then
  cp "$SRC/config/provider/zcode-builtin.json" "$WT/config/provider/zcode-builtin.json"
fi

# Patches: exactly the @ai-sdk set upstream ships.
mkdir -p "$WT/patches"
rm -f "$WT/patches/"*.patch
for patch in "$SRC/patches/"@ai-sdk__*.patch; do
  if [ -f "$patch" ]; then
    cp "$patch" "$WT/patches/"
  fi
done

# Third-party attribution data.
if [ -d "$SRC/third-party" ]; then
  rm -rf "$WT/third-party"
  rsync -a --delete "$SRC/third-party/" "$WT/third-party/"
fi
rm -f "$WT/THIRD-PARTY-NOTICES.md"
if [ -f "$SRC/THIRD-PARTY-NOTICES.md" ]; then
  cp "$SRC/THIRD-PARTY-NOTICES.md" "$WT/"
fi

# Report upstream files under the mapped roots that the vendor tree lacks.
# Known omissions (packages this repo does not ship, the cli/tui bundler
# scripts, non-ai-sdk patches) are filtered; anything left is a mapping
# decision for a human, not noise. Stage first, so the comparison sees the
# freshly synced tree.
git -C "$WT" add -A
git -C "$ZCODE_REPO" ls-tree -r --name-only "$REV" \
  -- apps/zcode-cli/packages packages patches config/provider third-party \
  > "$WORK/upstream.txt"
if [ -f "$SRC/THIRD-PARTY-NOTICES.md" ]; then
  echo "THIRD-PARTY-NOTICES.md" >> "$WORK/upstream.txt"
fi
awk -v apps="$APPS_PACKAGES" -v roots="$ROOT_PACKAGES" '
  BEGIN {
    n = split(apps, a, " "); for (i = 1; i <= n; i++) apps_pkg[a[i]] = 1
    n = split(roots, r, " "); for (i = 1; i <= n; i++) root_pkg[r[i]] = 1
  }
  {
    p = $0
    if (p ~ /^apps\/zcode-cli\/packages\//) {
      sub(/^apps\/zcode-cli\/packages\//, "", p)
      pkg = p; sub(/\/.*$/, "", pkg)
      if (pkg in apps_pkg) print "packages/" p
    } else if (p ~ /^packages\//) {
      pkg = p; sub(/^packages\//, "", pkg); sub(/\/.*$/, "", pkg)
      if (pkg in root_pkg) print p
    } else if (p ~ /^patches\/@arms__/) {
      # known omission
    } else {
      print p
    }
  }
' "$WORK/upstream.txt" \
  | awk '/^packages\/cli\/scripts\// || /^packages\/tui\/scripts\// { next } { print }' \
  | sort > "$WORK/expected.txt"
git -C "$WT" ls-files | sort > "$WORK/vendored.txt"
comm -23 "$WORK/expected.txt" "$WORK/vendored.txt" > "$WORK/missing.txt" || true
if [ -s "$WORK/missing.txt" ]; then
  echo "NOTICE: upstream files under the mapped roots that were not vendored:" >&2
  sed 's/^/  /' "$WORK/missing.txt" >&2
fi

if git -C "$WT" diff --cached --quiet; then
  echo "vendor tree already matches $SHORT_REV (zcode $ZCODE_VERSION)"
  exit 0
fi
git -C "$WT" commit --quiet \
  -m "vendor: zcode $ZCODE_VERSION ($SHORT_REV)" \
  -m "Snapshot of zcode at $FULL_REV, generated by scripts/sync-vendor.sh.
Patch the copies on main, never on this branch."
echo "vendor branch updated: zcode $ZCODE_VERSION ($SHORT_REV)"
