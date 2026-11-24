#!/usr/bin/env bash
set -euo pipefail

: "${DMG_ARCH:?Set DMG_ARCH to aarch64 or x64}"
case "$DMG_ARCH" in
  aarch64) expected_arch=arm64; executable_arch=arm64 ;;
  x64) expected_arch=x64; executable_arch=x86_64 ;;
  *) echo "Unsupported DMG architecture: $DMG_ARCH" >&2; exit 1 ;;
esac
set -- desktop/src-tauri/target/release/bundle/dmg/*_"$DMG_ARCH".dmg
if [[ $# != 1 || ! -f "$1" ]]; then
  echo "Expected exactly one macOS DMG for $DMG_ARCH" >&2
  exit 1
fi
scratch=$(mktemp -d)
mounted=false
cleanup() {
  if [[ $mounted == true ]]; then hdiutil detach "$scratch/mount" -quiet || return; fi
  rmdir "$scratch/mount" "$scratch"
}
trap cleanup EXIT
mkdir "$scratch/mount"
hdiutil attach "$1" -readonly -nobrowse -mountpoint "$scratch/mount" -quiet
mounted=true

app="$scratch/mount/Auto-Agent.app"
runtime="$app/Contents/Resources/runtime"
node="$app/Contents/MacOS/auto-agent-node"
executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")
test "$(lipo -archs "$app/Contents/MacOS/$executable")" = "$executable_arch"
test -x "$node"
test -f "$runtime/NODE-LICENSE"
test -f "$runtime/.output/server/index.mjs"
test "$("$node" -p 'process.arch')" = "$expected_arch"
codesign --verify --deep --strict "$app"
if [[ -n ${APPLE_RELEASE_CHECK:-} ]]; then
  codesign --verify --strict "$1"
  xcrun stapler validate "$app"
fi

# The fixture relocates the runtime to writable scratch, exercising the Node
# sidecar from the DMG with the same fake model and vendor used on Windows.
AUTO_AGENT_TEST_RUNTIME="$runtime" AUTO_AGENT_TEST_NODE="$node" \
  bun test tests/corax/runtime.test.ts -t packaged --timeout 120000
