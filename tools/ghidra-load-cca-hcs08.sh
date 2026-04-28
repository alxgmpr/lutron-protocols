#!/usr/bin/env bash
# Load a Phoenix CCA HCS08 coproc binary into the existing Ghidra project at
# data/firmware/phoenix-device/coproc-firmware.rep.
#
# HCS08 SLEIGH in Ghidra is hardcoded 16-bit (0x0000-0xFFFF) but the binaries
# span 0x3000-0x1E808 (banked). We import only the un-paged window (0x3000-0xFFFF,
# 53248 bytes) — that's where the master radio dispatch lives. Banked code
# (0x10000+) is a follow-up; see docs/firmware-re/coproc.md.
#
# Usage:
#   tools/ghidra-load-cca-hcs08.sh data/firmware/phoenix-device/coprocessor/phoenix_hcs08_3000-1E808.bin

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <phoenix_hcs08_*.bin>" >&2
  exit 1
fi

SRC=$1
[[ -f "$SRC" ]] || { echo "missing: $SRC" >&2; exit 1; }

REPO_ROOT=$(git rev-parse --show-toplevel)
WRAPPER="$REPO_ROOT/tools/ghidra-headless.sh"
SCRIPT_DIR="$REPO_ROOT/tools/ghidra-scripts"

# data/ is gitignored and lives only in the main repo. From a worktree, follow
# the common git dir back to the main checkout.
DATA_REPO=$REPO_ROOT
[[ -d "$DATA_REPO/data/firmware/phoenix-device" ]] || DATA_REPO=$(dirname "$(git rev-parse --git-common-dir)")
[[ -d "$DATA_REPO/data/firmware/phoenix-device" ]] || { echo "no data/firmware/phoenix-device found in $REPO_ROOT or $DATA_REPO" >&2; exit 1; }

PROJ_DIR="$DATA_REPO/data/firmware/phoenix-device"
PROJ_NAME=coproc-firmware
NAME=$(basename "$SRC" .bin)_unpaged
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT
TMP="$WORK_DIR/$NAME"  # mktemp filename becomes the program name in Ghidra; pick something readable.

# Carve the un-paged window: file offset 0 maps to 0x3000, take up to (0xFFFF-0x3000+1)=0xD000=53248 bytes.
dd if="$SRC" of="$TMP" bs=1 count=53248 status=none

"$WRAPPER" "$PROJ_DIR" "$PROJ_NAME" \
  -import "$TMP" \
  -processor HCS08:BE:16:default \
  -loader BinaryLoader \
  -loader-baseAddr 0x3000 \
  -overwrite

echo "imported '$NAME' into $PROJ_DIR/$PROJ_NAME"
