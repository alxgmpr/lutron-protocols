#!/bin/bash
# Deploy CCX-WiZ Bridge to Home Assistant as a local add-on via SMB
#
# Usage: ./bridge/deploy-ha.sh [smb-mount-point]
#   Default mount point: /Volumes/config (HA config share)
#
# Prerequisites:
#   Mount HA SMB shares:
#     open smb://10.0.0.4   (then mount "config" and "addons")
#   Or from CLI:
#     mkdir -p /Volumes/config /Volumes/addons
#     mount_smbfs //user:pass@10.0.0.4/config /Volumes/config
#     mount_smbfs //user:pass@10.0.0.4/addons /Volumes/addons

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_MOUNT="${1:-/Volumes/config}"
ADDONS_MOUNT="${2:-/Volumes/addons}"

ADDON_DEST="$ADDONS_MOUNT/local/ccx-bridge"
DATA_DEST="$CONFIG_MOUNT/ccx-bridge"

# ── Validate mounts ──────────────────────────────────────

if [ ! -d "$CONFIG_MOUNT" ]; then
  echo "Error: Config share not mounted at $CONFIG_MOUNT"
  echo "Mount it first: open smb://10.0.0.4 → mount 'config'"
  exit 1
fi

if [ ! -d "$ADDONS_MOUNT" ]; then
  echo "Error: Addons share not mounted at $ADDONS_MOUNT"
  echo "Mount it first: open smb://10.0.0.4 → mount 'addons'"
  exit 1
fi

# ── Copy config/data files ───────────────────────────────

echo "=== Copying config data to $DATA_DEST ==="
mkdir -p "$DATA_DEST"

cp -v "$PROJECT_ROOT/config/ccx-bridge.json"     "$DATA_DEST/ccx-bridge.json"
cp -v "$PROJECT_ROOT/data/preset-zones.json"      "$DATA_DEST/preset-zones.json"
cp -v "$PROJECT_ROOT/data/leap-10.0.0.1.json"   "$DATA_DEST/leap-10.0.0.1.json"
cp -v "$PROJECT_ROOT/data/ccx-device-map.json"     "$DATA_DEST/ccx-device-map.json"

echo ""

# ── Assemble add-on directory ────────────────────────────

echo "=== Building add-on in $ADDON_DEST ==="
mkdir -p "$ADDON_DEST"

# Clean previous deployment
rm -rf "${ADDON_DEST:?}/lib" "${ADDON_DEST:?}/ccx" "${ADDON_DEST:?}/protocol" \
       "${ADDON_DEST:?}/bridge" "${ADDON_DEST:?}/tools"

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

echo "Copying tools/leap-client.ts..."
mkdir -p "$ADDON_DEST/tools"
cp "$PROJECT_ROOT/tools/leap-client.ts" "$ADDON_DEST/tools/leap-client.ts"

echo ""
echo "=== Deployment complete ==="
echo ""
echo "Config data:  $DATA_DEST"
echo "Add-on:       $ADDON_DEST"
echo ""
echo "Next steps:"
echo "  1. HA UI → Settings → Add-ons → ⋮ → Check for updates"
echo "  2. Find 'CCX-WiZ Bridge' under Local add-ons → Install"
echo "  3. Configuration tab → set Thread channel & master key"
echo "  4. Start the add-on, check Logs tab"
