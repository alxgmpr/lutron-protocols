#!/usr/bin/env bash
# Load a Phoenix/Caseta ARM Cortex-M radio coproc binary into the existing Ghidra
# project at data/firmware/phoenix-device/coproc-firmware.rep.
#
# Replaces the earlier ghidra-load-cca-hcs08.sh, which loaded these as HCS08.
# Per PR #34, the phoenix_hcs08_*.bin and phoenix_efr32_*.bin files are all ARM
# Cortex-M (valid Cortex-M vector tables at offset 0). The "hcs08" naming came
# from a heuristic in coproc-extract.py that read address ranges; it was wrong.
#
# Base address is parsed from the filename pattern *_<starthex>-<endhex>.bin, or
# can be passed explicitly. The whole file is loaded as one block.
#
# Usage:
#   tools/ghidra-load-arm-coproc.sh <bin> [base-addr-hex]
#
# Examples:
#   tools/ghidra-load-arm-coproc.sh data/firmware/phoenix-device/coprocessor/phoenix_efr32_8003000-801FB08.bin
#   # base auto-detected as 0x08003000
#
#   tools/ghidra-load-arm-coproc.sh data/firmware/phoenix-device/coprocessor/phoenix_hcs08_3000-1E808.bin
#   # base auto-detected as 0x00003000

set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <bin> [base-addr-hex]" >&2
  exit 1
fi

SRC=$1
[[ -f "$SRC" ]] || { echo "missing: $SRC" >&2; exit 1; }

if [[ $# -eq 2 ]]; then
  BASE=$2
else
  # Parse base from filename: anything_<starthex>-<endhex>.bin -> starthex
  BIN_BASENAME=$(basename "$SRC" .bin)
  if [[ "$BIN_BASENAME" =~ _([0-9A-Fa-f]+)-[0-9A-Fa-f]+$ ]]; then
    BASE="0x${BASH_REMATCH[1]}"
  else
    echo "couldn't parse base address from filename '$BIN_BASENAME'; pass explicitly as 2nd arg" >&2
    exit 1
  fi
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
WRAPPER="$REPO_ROOT/tools/ghidra-headless.sh"

# data/ is gitignored and lives only in the main repo. From a worktree, follow
# the common git dir back to the main checkout.
DATA_REPO=$REPO_ROOT
[[ -d "$DATA_REPO/data/firmware/phoenix-device" ]] || DATA_REPO=$(dirname "$(git rev-parse --git-common-dir)")
[[ -d "$DATA_REPO/data/firmware/phoenix-device" ]] || { echo "no data/firmware/phoenix-device found in $REPO_ROOT or $DATA_REPO" >&2; exit 1; }

PROJ_DIR="$DATA_REPO/data/firmware/phoenix-device"
PROJ_NAME=coproc-firmware
NAME=$(basename "$SRC" .bin)
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT
TMP="$WORK_DIR/$NAME"  # mktemp filename becomes the program name in Ghidra; use the binary name.

cp "$SRC" "$TMP"

"$WRAPPER" "$PROJ_DIR" "$PROJ_NAME" \
  -import "$TMP" \
  -processor ARM:LE:32:Cortex \
  -loader BinaryLoader \
  -loader-baseAddr "$BASE" \
  -overwrite

echo "imported '$NAME' (base $BASE) into $PROJ_DIR/$PROJ_NAME"
