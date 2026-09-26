#!/bin/bash
export PATH="$HOME/.local/bin:$PWD/node_modules/.bin:$PATH"
export NODE_OPTIONS="--max-old-space-size=6144"
: > /tmp/build-status.txt
for p in contracts dynamic-workflow i18n telemetry dynamic-workflow-runtime adapters core bootstrap; do
  printf "%-26s" "$p:" >> /tmp/build-status.txt
  if (cd packages/$p && tsc > /tmp/tsc-$p.log 2>&1); then
    echo "OK ($(find packages/$p/dist -name '*.js' | wc -l) js)" >> /tmp/build-status.txt
  else
    echo "FAIL (see /tmp/tsc-$p.log)" >> /tmp/build-status.txt
    exit 1
  fi
done
echo "ALL_DONE" >> /tmp/build-status.txt
