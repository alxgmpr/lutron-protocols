#!/usr/bin/env bash
# BDM-recovery wrapper for HCS08 PowPak modules — drives USBDM_Programmer to
# mass-erase + program + verify a bricked PowPak from the original Lutron LDF
# image. Designed for the post-OTA-brick recovery flow documented in
# docs/firmware-re/powpak-bdm-recovery.md.
#
# Usage:
#   tools/firmware/bdm-recovery.sh --target <part> --image <file.bin> [--erase-only]
#
# Examples:
#   # Recover an RMJ-16R-DV-B (line-voltage relay 434 MHz)
#   tools/firmware/bdm-recovery.sh \
#     --target MC9S08QE128 \
#     --image data/firmware-re/powpak/PowPakRelay434_1-49.bin
#
#   # Just erase to clear SEC bit, no program
#   tools/firmware/bdm-recovery.sh --target MC9S08QE128 --erase-only
#
# Prerequisites:
#   1. USBDM hardware connected via USB.
#   2. USBDM_Programmer installed at /Applications/USBDM/USBDM_Programmer.app
#      (Mac) or `usbdm-programmer` in $PATH (Linux). Download from
#      https://github.com/podonoghue/usbdm-eclipse-makefiles-build/releases
#   3. PowPak target wired to USBDM (BKGD/RST/VDD/GND) and powered.
#   4. Disconnect and re-power the target between runs to ensure fresh state.

set -euo pipefail

# -----------------------------------------------------------------------------
# Defaults
# -----------------------------------------------------------------------------
TARGET=""
IMAGE=""
ERASE_ONLY=0
ADDR=0x0000
VERIFY=1

# Locate USBDM_Programmer binary (Mac install path or Linux $PATH)
USBDM_BIN=""
if [[ "$(uname)" == "Darwin" ]]; then
    if [[ -x "/Applications/USBDM/USBDM_Programmer.app/Contents/MacOS/USBDM_Programmer" ]]; then
        USBDM_BIN="/Applications/USBDM/USBDM_Programmer.app/Contents/MacOS/USBDM_Programmer"
    fi
fi
if [[ -z "$USBDM_BIN" ]] && command -v usbdm-programmer &>/dev/null; then
    USBDM_BIN="$(command -v usbdm-programmer)"
fi

# -----------------------------------------------------------------------------
# Arg parsing
# -----------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --target)        TARGET="$2"; shift 2 ;;
        --image)         IMAGE="$2"; shift 2 ;;
        --addr)          ADDR="$2"; shift 2 ;;
        --erase-only)    ERASE_ONLY=1; shift ;;
        --no-verify)     VERIFY=0; shift ;;
        --usbdm)         USBDM_BIN="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,30p' "$0"
            exit 0
            ;;
        *) echo "Unknown arg: $1" >&2; exit 2 ;;
    esac
done

# -----------------------------------------------------------------------------
# Validation
# -----------------------------------------------------------------------------
if [[ -z "$USBDM_BIN" ]]; then
    cat >&2 <<EOF
ERROR: USBDM_Programmer not found.
Install from https://github.com/podonoghue/usbdm-eclipse-makefiles-build/releases
or pass --usbdm /path/to/usbdm-programmer.
EOF
    exit 1
fi

if [[ -z "$TARGET" ]]; then
    cat >&2 <<EOF
ERROR: --target required (e.g. --target MC9S08QE128).
Identify the MCU part number from the silkscreen on the PowPak's main IC.
EOF
    exit 2
fi

if [[ "$ERASE_ONLY" -eq 0 && -z "$IMAGE" ]]; then
    echo "ERROR: --image required (or use --erase-only)." >&2
    exit 2
fi

if [[ "$ERASE_ONLY" -eq 0 && ! -f "$IMAGE" ]]; then
    echo "ERROR: --image '$IMAGE' not found." >&2
    exit 1
fi

# -----------------------------------------------------------------------------
# Pre-flight: print plan + image info
# -----------------------------------------------------------------------------
echo "============================================================"
echo "USBDM:   $USBDM_BIN"
echo "Target:  $TARGET"
if [[ "$ERASE_ONLY" -eq 1 ]]; then
    echo "Mode:    ERASE ONLY (clears SEC bit; no program)"
else
    SIZE=$(wc -c < "$IMAGE" | tr -d ' ')
    SHA=$(shasum -a 256 "$IMAGE" | awk '{print $1}')
    echo "Image:   $IMAGE ($SIZE bytes, sha256=$SHA)"
    echo "Address: $ADDR"
    echo "Verify:  $([[ $VERIFY -eq 1 ]] && echo yes || echo no)"
fi
echo "============================================================"
echo ""
read -r -p "Confirm: target is wired and powered? Type 'yes' to proceed: " ACK
if [[ "$ACK" != "yes" ]]; then
    echo "Aborted."
    exit 1
fi

# -----------------------------------------------------------------------------
# Step 1: detect chip
# -----------------------------------------------------------------------------
echo ""
echo ">>> Step 1: detect chip"
"$USBDM_BIN" --target="$TARGET" --device="$TARGET" --command=connect || {
    cat >&2 <<EOF

ERROR: chip detection failed. Common causes:
  - USBDM not plugged in (check 'lsusb' / 'system_profiler SPUSBDataType')
  - BDM wires loose / wrong pinout / swapped BKGD↔RST
  - Target not powered (verify 3.3V at MCU VDD pin with multimeter)
  - Wrong --target (silkscreen says one part, you typed another)
  - SEC bit set AND BDM_DIS fuse set (bricks BDM permanently — uncommon)
EOF
    exit 1
}

# -----------------------------------------------------------------------------
# Step 2: mass erase (clears SEC bit; works even when read is locked)
# -----------------------------------------------------------------------------
echo ""
echo ">>> Step 2: mass erase (clears SEC bit + all flash)"
"$USBDM_BIN" --target="$TARGET" --device="$TARGET" --command=mass_erase

if [[ "$ERASE_ONLY" -eq 1 ]]; then
    echo ""
    echo "Mass erase complete. Skipping program (--erase-only)."
    exit 0
fi

# -----------------------------------------------------------------------------
# Step 3: program image
# -----------------------------------------------------------------------------
echo ""
echo ">>> Step 3: program $IMAGE @ $ADDR"
"$USBDM_BIN" \
    --target="$TARGET" \
    --device="$TARGET" \
    --image="$IMAGE" \
    --addr="$ADDR" \
    --command=program

# -----------------------------------------------------------------------------
# Step 4: verify
# -----------------------------------------------------------------------------
if [[ "$VERIFY" -eq 1 ]]; then
    echo ""
    echo ">>> Step 4: verify"
    "$USBDM_BIN" \
        --target="$TARGET" \
        --device="$TARGET" \
        --image="$IMAGE" \
        --addr="$ADDR" \
        --command=verify
fi

# -----------------------------------------------------------------------------
# Step 5: reset target into user mode
# -----------------------------------------------------------------------------
echo ""
echo ">>> Step 5: reset target → user mode"
"$USBDM_BIN" --target="$TARGET" --device="$TARGET" --command=reset

echo ""
echo "============================================================"
echo "DONE. Disconnect BDM cable, power-cycle the target."
echo ""
echo "Verification checklist:"
echo "  [ ] Power LED flashes on power-up"
echo "  [ ] LED responds to button press"
echo "  [ ] Pair to host system (ESN for RMJ; RA3 for LMJ; Vive for RMJS)"
echo "============================================================"
