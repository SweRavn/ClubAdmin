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

flows() {
  maestro test --format junit --output "$out/$1.xml" --debug-output "$out/$1" \
    -e APP_ID="$app_id" -e APP_SCHEME="$scheme" "${@:2}"
}

flows personas maestro/01-login-and-switch-club.yaml maestro/02-protected-identity.yaml \
  maestro/03-language.yaml maestro/04-viewing-as.yaml

# The app is logged in (Anna) with a filled cache: measure cold starts.
scripts/measure-cold-start.sh "$app_id" 5 2000 | tee "$out/cold-start.txt"

flows offline maestro/05-offline-and-logout.yaml

password="Maestro-$(date +%s)aA1"
email="$(node scripts/create-e2e-user.mts "$password")"
flows zitadel -e EMAIL="$email" -e PASSWORD="$password" maestro/06-zitadel-login.yaml
