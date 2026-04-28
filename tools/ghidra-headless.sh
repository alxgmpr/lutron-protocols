#!/usr/bin/env bash
# Wrapper around Ghidra's analyzeHeadless.
#
# - Auto-finds the install (env GHIDRA_HOME, or /Applications/, or ~/Downloads/ghidra_*).
# - Falls back to analyzeHeadless.bak if the main script has been zeroed out
#   (a known issue with some Ghidra unpacks).
#
# Usage:
#   tools/ghidra-headless.sh <project-dir> <project-name> [analyzeHeadless args...]
#
# Examples:
#   tools/ghidra-headless.sh data/firmware/phoenix-device coproc-firmware -readOnly \
#     -preScript ListProjectPrograms.java -scriptPath tools/ghidra-scripts -noanalysis
#
#   tools/ghidra-headless.sh /tmp/ghidra-test myproj \
#     -import some.bin -processor HCS08:BE:16:default -loader BinaryLoader \
#     -loader-baseAddr 0x3000 -overwrite

set -euo pipefail

find_ghidra() {
  if [[ -n "${GHIDRA_HOME:-}" && -d "$GHIDRA_HOME" ]]; then
    echo "$GHIDRA_HOME"
    return
  fi
  for c in /Applications/ghidra_*_PUBLIC ~/Downloads/ghidra_*_PUBLIC /opt/ghidra_*_PUBLIC; do
    [[ -d "$c" ]] && { echo "$c"; return; }
  done
  echo "Ghidra not found. Set GHIDRA_HOME or extract a ghidra_*_PUBLIC release." >&2
  exit 1
}

GH=$(find_ghidra)
SCRIPT="$GH/support/analyzeHeadless"
[[ -s "$SCRIPT" ]] || SCRIPT="$GH/support/analyzeHeadless.bak"
[[ -s "$SCRIPT" ]] || { echo "neither analyzeHeadless nor .bak is usable in $GH/support" >&2; exit 1; }

exec bash "$SCRIPT" "$@"
