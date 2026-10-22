#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Cold start to Home with cached data on a running Android device or
# emulator (docs/performance.md, "Mobile"). The app must be installed and
# logged in once (its query cache filled). Each run force-stops the app,
# starts it and waits for the "home ready (cache)" line the app logs (not in
# production builds); the time is from the activity start to that line, from
# logcat's own timestamps.
# Usage: scripts/measure-cold-start.sh <applicationId> [runs] [budgetMs]
set -euo pipefail

app="${1:?applicationId}"
runs="${2:-5}"
budget="${3:-2000}"
times=()

for i in $(seq 1 "$runs"); do
  adb shell am force-stop "$app"
  sleep 2
  adb logcat -c
  adb shell am start -n "$app/.MainActivity" > /dev/null
  found=""
  for _ in $(seq 1 60); do
    if adb logcat -d -v epoch -s ReactNativeJS:I | grep -q "ClubAdmin: home ready (cache)"; then
      found=1
      break
    fi
    sleep 0.5
  done
  if [ -z "$found" ]; then
    echo "run $i: Home did not render from the cache within 30 s" >&2
    adb logcat -d -s ReactNativeJS:* | tail -20 >&2
    exit 1
  fi
  start=$(adb logcat -d -v epoch | grep -m1 -E "START u0 .*$app" | awk '{print $1}')
  ready=$(adb logcat -d -v epoch -s ReactNativeJS:I | grep -m1 "home ready (cache)" | awk '{print $1}')
  ms=$(awk -v s="$start" -v r="$ready" 'BEGIN { printf "%d", (r - s) * 1000 }')
  echo "run $i: ${ms} ms"
  times+=("$ms")
done

median=$(printf '%s\n' "${times[@]}" | sort -n | awk '{ a[NR] = $1 } END { print a[int((NR + 1) / 2)] }')
echo "cold start to cached Home: median ${median} ms over ${runs} runs (budget ${budget} ms)"
if [ "$median" -gt "$budget" ]; then
  echo "over budget" >&2
  exit 1
fi
