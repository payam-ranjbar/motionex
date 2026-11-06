#!/bin/sh
# Remove files from node_modules that the renderer never loads at runtime.
set -eu
NM="${1:-node_modules}"

case "$(uname -m)" in
  x86_64) KEEP="linux-x64-gnu" ;;
  aarch64) KEEP="linux-arm64-gnu" ;;
  armv7l) KEEP="linux-arm-gnueabihf" ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

# node-web-audio-api ships prebuilt addons for every platform (~40 MB); keep ours.
find "$NM/node-web-audio-api" -maxdepth 1 -name '*.node' ! -name "*.$KEEP.node" -delete

# @strudel/tonal depends on webmidi for MIDI output, which isn't used by the renderer.
rm -rf "$NM/webmidi" "$NM/jzz" "$NM/jazz-midi"

# Docs, typings, source maps, tests.
find "$NM" -type f \( \
    -name '*.md' -o -name '*.markdown' -o -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
    -o -name 'CHANGELOG*' -o -name 'HISTORY*' -o -name '.npmignore' -o -name '.eslintrc*' -o -name '.prettierrc*' \
    -o -name 'tsconfig*.json' -o -name '*.ts' -a ! -name '*.d.ts' \
  \) -delete
find "$NM" -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name example -o -name examples -o -name .github \) \
  -prune -exec rm -rf {} +

du -sh "$NM"
