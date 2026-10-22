#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Runs inside the CI emulator step (.github/workflows/ci.yml, job "mobile"):
# prepares the emulator for the local services, installs the development
# build and runs the Maestro flows and the cold-start measurement.
# Expects: a booted emulator, the services and the API running, the APK at
# $APK, Maestro on PATH, ZITADEL_PAT for the Zitadel login flow.
set -euo pipefail
cd "$(dirname "$0")/.."

app_id="org.clubadmin.app.dev"
scheme="clubadmin-dev"
out="${MAESTRO_OUT:-/tmp/maestro}"
mkdir -p "$out"
# Node's fetch (the e2e user script) trusts Caddy's CA.
export NODE_EXTRA_CA_CERTS="$PWD/../../.local/caddy-root.crt"

# Caddy's CA in the emulator's user store, port 443 forwarded to Caddy.
pnpm --dir ../.. dev:trust-ca --android
adb install -r "$APK"
adb logcat -c || true

# On failure: what the screen shows and the app's log, in the job log (the
# Maestro screenshots are in the uploaded report).
diagnose() {
  echo "::group::Screen texts after the failed flow"
  maestro hierarchy 2>/dev/null | grep -oE '"(text|accessibilityText|resource-id)" *: *"[^"]+"' | sort -u | head -100 || true
  echo "::endgroup::"
  echo "::group::logcat (React Native, crashes)"
  adb logcat -d -v time >"$out/logcat.txt" || true
  grep -E "ReactNativeJS|ReactNative|AndroidRuntime|FATAL|ClubAdmin|Nitro|MMKV|SecureStore" "$out/logcat.txt" | tail -200 || true
  echo "::endgroup::"
}

flows() {
  if ! maestro test --format junit --output "$out/$1.xml" --debug-output "$out/$1" \
    -e APP_ID="$app_id" -e APP_SCHEME="$scheme" "${@:2}"; then
    diagnose
    return 1
  fi
}

flows personas maestro/01-login-and-switch-club.yaml maestro/02-protected-identity.yaml \
  maestro/03-language.yaml maestro/04-viewing-as.yaml

# The app is logged in (Anna) with a filled cache: measure cold starts.
scripts/measure-cold-start.sh "$app_id" 5 2000 | tee "$out/cold-start.txt"

flows offline maestro/05-offline-and-logout.yaml

password="Maestro-$(date +%s)aA1"
email="$(node scripts/create-e2e-user.mts "$password")"
flows zitadel -e EMAIL="$email" -e PASSWORD="$password" maestro/06-zitadel-login.yaml
