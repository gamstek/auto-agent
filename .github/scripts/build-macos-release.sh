#!/usr/bin/env bash
set -euo pipefail

for key in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_SIGNING_IDENTITY; do
  if [[ -z ${!key:-} ]]; then
    echo "Missing macOS release signing configuration: $key" >&2
    exit 1
  fi
done
if [[ "$APPLE_SIGNING_IDENTITY" != 'Developer ID Application:'* ]]; then
  echo 'macOS releases require a Developer ID Application identity' >&2
  exit 1
fi

# Import once so runtime preparation can sign native dependencies before
# Tauri seals the enclosing app and submits it for notarization.
scratch=$(mktemp -d)
keychain="$scratch/signing.keychain-db"
previous=()
while IFS= read -r line; do
  line=${line#*\"}; line=${line%\"*}
  [[ -z "$line" ]] || previous+=("$line")
done < <(security list-keychains -d user)
cleanup() {
  if ((${#previous[@]})); then security list-keychains -d user -s "${previous[@]}" || true; fi
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
password=$(openssl rand -hex 24)
printf '%s' "$APPLE_CERTIFICATE" | base64 -D > "$scratch/certificate.p12"
security create-keychain -p "$password" "$keychain"
security unlock-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security import "$scratch/certificate.p12" -k "$keychain" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain"
security list-keychains -d user -s "$keychain" "${previous[@]}"
unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD
export AUTO_AGENT_SIGN_MACOS_RUNTIME=1
pnpm build:desktop
