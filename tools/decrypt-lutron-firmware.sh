#!/usr/bin/env bash
# Decrypt a Lutron lutron_firmware bundle (Phoenix RA3 / Caseta Pro / lite-heron / HWQSX).
#
# Bundle structure (per docs/security/firmware-cdn.md):
#   lutron_firmware (ZIP)
#     firmware.tar.enc   — AES-128-CBC payload (the prize: rootfs .debs + device .pff files)
#     key.tar            — contains key.enc, iv.hex, algorithm, message_digest
#     versionInfo, manifest, manifest.sig, EULA, ...
#
# Decryption (current symmetric scheme, ~2021+ bundles):
#   1. Extract key.tar from the ZIP
#   2. Decrypt key.enc (base64-AES-wrapped passphrase) with the device key + iv.hex
#   3. Decrypt firmware.tar.enc with the recovered passphrase (md5 KDF)
#   4. Untar firmware.tar
#
# Device key is the same across all RA3/HWQSX/lite-heron bundles, extracted from
# Phoenix processor eMMC via UART boot (see docs/security/phoenix-root.md).
#
# Usage:
#   tools/decrypt-lutron-firmware.sh <lutron_firmware-zip> <output-dir>
#
# Example:
#   tools/decrypt-lutron-firmware.sh data/firmware/lite-heron-lutron_firmware data/firmware/lite-heron-decrypted

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <lutron_firmware-zip> <output-dir>" >&2
  exit 1
fi

ZIP=$1
OUT=$2
DEVICE_KEY=${LUTRON_DEVICE_KEY:-6cba80b2bf3cf2a63be017340f1801d8}

[[ -f "$ZIP" ]] || { echo "missing: $ZIP" >&2; exit 1; }

mkdir -p "$OUT"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "[1/5] Unzipping bundle into $OUT"
unzip -q -o "$ZIP" -d "$OUT"

echo "[2/5] Extracting key.tar"
tar xf "$OUT/key.tar" -C "$WORK"

ALGORITHM=$(cat "$WORK/algorithm" 2>/dev/null || echo "(missing)")
DIGEST=$(cat "$WORK/message_digest" 2>/dev/null || echo "(missing)")
echo "      algorithm=${ALGORITHM} digest=${DIGEST}"

echo "[3/5] Decrypting AES-wrapped passphrase"
openssl enc -d -aes-128-cbc -in "$WORK/key.enc" -base64 \
  -K "$DEVICE_KEY" \
  -iv "$(cat "$WORK/iv.hex")" \
  -out "$WORK/passphrase.bin"

echo "[4/5] Decrypting firmware.tar.enc"
openssl enc -d -aes-128-cbc -md md5 \
  -pass "file:$WORK/passphrase.bin" \
  -in "$OUT/firmware.tar.enc" \
  -out "$OUT/firmware.tar"

echo "[5/5] Untarring firmware.tar"
mkdir -p "$OUT/firmware"
tar xf "$OUT/firmware.tar" -C "$OUT/firmware"

VERSION=$(cat "$OUT/versionInfo" 2>/dev/null | tr -d '\n' || echo "?")
echo
echo "Done. Version: $VERSION"
echo "Decrypted contents:"
ls -la "$OUT/firmware" | head -20
