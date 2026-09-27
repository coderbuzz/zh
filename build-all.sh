#!/bin/sh
# Build every TypeScript workspace package in dependency order.
# Output progress to stdout and a summary to /tmp/build-status.txt.
set -e

ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"

export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}"
TSC="$ROOT/node_modules/.bin/tsc"
STATUS=/tmp/build-status.txt
: > "$STATUS"

# dynamic-workflow needs generated lib files before tsc can resolve its imports.
if [ ! -f packages/dynamic-workflow/src/compiler/libs.generated.js ]; then
  echo "generating dynamic-workflow libs..." >&2
  (cd packages/dynamic-workflow && node scripts/generate-libs.mjs)
fi

for p in \
  shared-types \
  model-option-map \
  shared \
  contracts \
  provider \
  provider-node \
  dynamic-workflow \
  i18n \
  telemetry \
  dynamic-workflow-runtime \
  adapters \
  core \
  bootstrap
do
  printf "%-26s" "$p:" >> "$STATUS"
  if (cd "packages/$p" && "$TSC" > "/tmp/tsc-$p.log" 2>&1); then
    echo "OK ($(find "packages/$p/dist" -name '*.js' 2>/dev/null | wc -l | tr -d ' ') js)" >> "$STATUS"
    echo "$p: OK" >&2
  else
    echo "FAIL (see /tmp/tsc-$p.log)" >> "$STATUS"
    echo "$p: FAIL" >&2
    tail -5 "/tmp/tsc-$p.log" >&2
    exit 1
  fi
done

# tui emits declarations with tsc, then bundles dist/index.js with Bun.build.
# The bundle step needs the bun runtime, so it cannot run under tsc like the rest.
printf "%-26s" "tui:" >> "$STATUS"
if (cd packages/tui && "$TSC" > /tmp/tsc-tui.log 2>&1 && bun scripts/build.mjs >> /tmp/tsc-tui.log 2>&1); then
  echo "OK" >> "$STATUS"
  echo "tui: OK" >&2
else
  echo "FAIL (see /tmp/tsc-tui.log)" >> "$STATUS"
  echo "tui: FAIL" >&2
  tail -5 /tmp/tsc-tui.log >&2
  exit 1
fi

echo "ALL_DONE" >> "$STATUS"
echo "all packages built" >&2
