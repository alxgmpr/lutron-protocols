#!/bin/bash
# Deploy CCX-WiZ Bridge to Home Assistant as a local add-on via SMB.
#
# Reads the HA host and the primary processor IP from config.json (looking in
# the worktree root and falling back to the main checkout, since config.json
# is gitignored and typically lives only in the main repo).
#
# Usage: ./bridge/deploy-ha.sh [config-mount] [addons-mount]
#
# Prerequisites:
#   Mount HA SMB shares first:
#     open smb://<homeassistant.host>   (then mount "config" and "addons")

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_MOUNT="${1:-/Volumes/config}"
ADDONS_MOUNT="${2:-/Volumes/addons}"

ADDON_DEST="$ADDONS_MOUNT/local/ccx-bridge"
DATA_DEST="$CONFIG_MOUNT/ccx-bridge"

# ── Locate config.json ──────────────────────────────────
# Try the worktree root first, then the main checkout (git common dir's parent).

CONFIG_FILE=""
for candidate in \
    "$PROJECT_ROOT/config.json" \
    "$(git -C "$PROJECT_ROOT" rev-parse --git-common-dir 2>/dev/null)/../config.json"; do
  if [ -f "$candidate" ]; then
    CONFIG_FILE="$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")"
    break
  fi
done

if [ -z "$CONFIG_FILE" ]; then
  echo "Error: config.json not found in worktree or main checkout"
  echo "Copy config.example.json → config.json in the main repo and fill it in"
  exit 1
fi

echo "Using config: $CONFIG_FILE"

HA_HOST="$(jq -r '.homeassistant.host // empty' "$CONFIG_FILE")"
PROCESSOR_IP="$(jq -r '.processors | keys[0] // empty' "$CONFIG_FILE")"

if [ -z "$HA_HOST" ]; then
  echo "Error: homeassistant.host not set in $CONFIG_FILE"
  echo 'Add: "homeassistant": { "host": "<ha-ip>" }'
  exit 1
fi

if [ -z "$PROCESSOR_IP" ]; then
  echo "Error: no processors configured in $CONFIG_FILE"
  exit 1
fi

LEAP_FILE="$PROJECT_ROOT/data/leap-${PROCESSOR_IP}.json"
DEVICE_MAP_FILE="$PROJECT_ROOT/data/ccx-device-map.json"
PRESET_ZONES_FILE="$PROJECT_ROOT/data/preset-zones.json"

# Worktree may be missing data files — fall back to main checkout for those too.
MAIN_DATA_DIR="$(git -C "$PROJECT_ROOT" rev-parse --git-common-dir 2>/dev/null)/../data"
for var in LEAP_FILE DEVICE_MAP_FILE PRESET_ZONES_FILE; do
  path="${!var}"
  if [ ! -f "$path" ] && [ -f "$MAIN_DATA_DIR/$(basename "$path")" ]; then
    eval "$var=\"\$(cd \"\$MAIN_DATA_DIR\" && pwd)/\$(basename \"\$path\")\""
  fi
done

# ── Validate mounts ──────────────────────────────────────

if [ ! -d "$CONFIG_MOUNT" ]; then
  echo "Error: Config share not mounted at $CONFIG_MOUNT"
  echo "Mount it first: open smb://$HA_HOST → mount 'config'"
  exit 1
fi

if [ ! -d "$ADDONS_MOUNT" ]; then
  echo "Error: Addons share not mounted at $ADDONS_MOUNT"
  echo "Mount it first: open smb://$HA_HOST → mount 'addons'"
  exit 1
fi

# ── Validate data files ──────────────────────────────────

for path in "$LEAP_FILE" "$DEVICE_MAP_FILE" "$PRESET_ZONES_FILE"; do
  if [ ! -f "$path" ]; then
    echo "Error: data file not found: $path"
    exit 1
  fi
done

# ── Copy LEAP/preset data files ──────────────────────────
# (Pairings + settings are configured in HA add-on UI, not here)

echo "=== Copying LEAP data to $DATA_DEST ==="
mkdir -p "$DATA_DEST"

cp -v "$PRESET_ZONES_FILE" "$DATA_DEST/preset-zones.json"
cp -v "$LEAP_FILE"         "$DATA_DEST/leap-${PROCESSOR_IP}.json"
cp -v "$DEVICE_MAP_FILE"   "$DATA_DEST/ccx-device-map.json"

echo ""

# ── Assemble add-on directory ────────────────────────────

echo "=== Building add-on in $ADDON_DEST ==="
mkdir -p "$ADDON_DEST"

# Clean previous deployment
rm -rf "${ADDON_DEST:?}/lib" "${ADDON_DEST:?}/ccx" "${ADDON_DEST:?}/protocol" \
       "${ADDON_DEST:?}/bridge"

# Add-on manifest and entrypoint
cp -v "$PROJECT_ROOT/bridge/ha-addon/config.yaml"  "$ADDON_DEST/config.yaml"
cp -v "$PROJECT_ROOT/bridge/ha-addon/Dockerfile"    "$ADDON_DEST/Dockerfile"
cp -v "$PROJECT_ROOT/bridge/ha-addon/run.sh"        "$ADDON_DEST/run.sh"

# Node.js project files
cp -v "$PROJECT_ROOT/package.json"      "$ADDON_DEST/package.json"
cp -v "$PROJECT_ROOT/package-lock.json" "$ADDON_DEST/package-lock.json"
cp -v "$PROJECT_ROOT/tsconfig.json"     "$ADDON_DEST/tsconfig.json"

# Source directories needed by the bridge
echo "Copying lib/..."
cp -r "$PROJECT_ROOT/lib" "$ADDON_DEST/lib"

echo "Copying ccx/..."
cp -r "$PROJECT_ROOT/ccx" "$ADDON_DEST/ccx"

echo "Copying protocol/..."
cp -r "$PROJECT_ROOT/protocol" "$ADDON_DEST/protocol"

echo "Copying bridge/main.ts..."
mkdir -p "$ADDON_DEST/bridge"
cp "$PROJECT_ROOT/bridge/main.ts" "$ADDON_DEST/bridge/main.ts"

echo ""
echo "=== Deployment complete ==="
echo ""
echo "Add-on:     $ADDON_DEST"
echo "LEAP data:  $DATA_DEST"
echo ""
echo "Next steps:"
echo "  1. HA UI → Settings → Add-ons → ⋮ → Check for updates"
echo "  2. Find 'CCX-WiZ Bridge' under Local add-ons → Install"
echo "  3. Configuration tab → set ALL settings (pairings, Thread creds, etc.)"
echo "  4. Start the add-on, check Logs tab"
