#!/bin/bash
# Deploy a bridge add-on to Home Assistant as a local add-on via SMB.
#
# Two add-ons share this script because they share their source tree and their
# LEAP data:
#
#   ADDON=openlutron  (default)  openlutron board → MQTT/HA, CCA + CCX
#   ADDON=ccx                    nRF sniffer dongle → WiZ + MQTT/HA
#
# The openlutron add-on supersedes the CCX-WiZ one. Run one at a time against a
# given broker — two bridges publishing the same topics will fight.
#
# Reads the HA host and the primary processor IP from config.json (looking in
# the worktree root and falling back to the main checkout, since config.json
# is gitignored and typically lives only in the main repo).
#
# Usage: ./bridge/deploy-ha.sh [config-mount] [addons-mount]
#        ADDON=ccx ./bridge/deploy-ha.sh [config-mount] [addons-mount]
#
# Prerequisites:
#   Mount HA SMB shares first:
#     open smb://<homeassistant.host>   (then mount "config" and "addons")

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_MOUNT="${1:-/Volumes/config}"
ADDONS_MOUNT="${2:-/Volumes/addons}"
ADDON="${ADDON:-openlutron}"

case "$ADDON" in
  openlutron)
    ADDON_SLUG="openlutron-bridge"
    ADDON_SRC="$PROJECT_ROOT/bridge/openlutron-addon"
    ADDON_ENTRY="bridge/openlutron-main.ts"
    ADDON_TITLE="openlutron Bridge"
    ;;
  ccx)
    ADDON_SLUG="ccx-bridge"
    ADDON_SRC="$PROJECT_ROOT/bridge/ha-addon"
    ADDON_ENTRY="bridge/main.ts"
    ADDON_TITLE="CCX-WiZ Bridge"
    ;;
  *)
    echo "Error: unknown ADDON=$ADDON (use openlutron or ccx)"
    exit 1
    ;;
esac

echo "=== Deploying $ADDON_TITLE (slug: $ADDON_SLUG) ==="

ADDON_DEST="$ADDONS_MOUNT/local/$ADDON_SLUG"
# Both add-ons read LEAP data from the same place; there is one system to
# describe, so duplicating the dump per add-on would just create two truths.
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

if [ -z "$HA_HOST" ]; then
  echo "Error: homeassistant.host not set in $CONFIG_FILE"
  echo 'Add: "homeassistant": { "host": "<ha-ip>" }'
  exit 1
fi

# ── Pick the processor ───────────────────────────────────
# Explicit choice wins. With several processors configured and no explicit
# choice, refuse rather than guess: `keys[0]` sorts lexically, so a config
# holding 10.1.10.37 and 10.1.9.2 silently selects .10.37 ("1" < "9" at the
# fifth character) — which may well be the wrong system entirely.

PROCESSOR_IP="${CCX_PROCESSOR:-$(jq -r '.bridge.processor // empty' "$CONFIG_FILE")}"

if [ -z "$PROCESSOR_IP" ]; then
  PROCESSOR_COUNT="$(jq -r '.processors | length' "$CONFIG_FILE")"
  if [ "$PROCESSOR_COUNT" = "1" ]; then
    PROCESSOR_IP="$(jq -r '.processors | keys[0]' "$CONFIG_FILE")"
  elif [ "$PROCESSOR_COUNT" = "0" ]; then
    echo "Error: no processors configured in $CONFIG_FILE"
    exit 1
  else
    echo "Error: $PROCESSOR_COUNT processors configured — name the one to deploy:"
    jq -r '.processors | keys[] | "  " + .' "$CONFIG_FILE"
    echo ""
    echo "  CCX_PROCESSOR=<ip> $0 $*"
    echo '  or add  "bridge": { "processor": "<ip>" }  to config.json'
    exit 1
  fi
fi

if ! jq -e --arg ip "$PROCESSOR_IP" '.processors | has($ip)' "$CONFIG_FILE" >/dev/null; then
  echo "Error: processor $PROCESSOR_IP is not in $CONFIG_FILE"
  jq -r '.processors | keys[] | "  " + .' "$CONFIG_FILE"
  exit 1
fi

echo "Processor: $PROCESSOR_IP"

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
cp -v "$ADDON_SRC/config.yaml"  "$ADDON_DEST/config.yaml"
cp -v "$ADDON_SRC/Dockerfile"   "$ADDON_DEST/Dockerfile"
cp -v "$ADDON_SRC/run.sh"       "$ADDON_DEST/run.sh"

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

echo "Copying $ADDON_ENTRY..."
mkdir -p "$ADDON_DEST/bridge"
cp "$PROJECT_ROOT/$ADDON_ENTRY" "$ADDON_DEST/$ADDON_ENTRY"

echo ""
echo "=== Deployment complete ==="
echo ""
echo "Add-on:     $ADDON_DEST"
echo "LEAP data:  $DATA_DEST"
echo ""
echo "Next steps:"
echo "  1. HA UI → Settings → Add-ons → ⋮ → Check for updates"
echo "  2. Find '$ADDON_TITLE' under Local add-ons → Install"
echo "     (already installed? Update if offered, else ⋮ → Rebuild — a local"
echo "      add-on only rebuilds when config.yaml's version changes)"
if [ "$ADDON" = "openlutron" ]; then
  echo "  3. Configuration tab → set openlutron_host (the board) and mqtt_url."
  echo "     No Thread credentials: the board decrypts CCX itself."
  echo "     WiZ pairings are optional — with none it observes and publishes."
  echo "  4. Start the add-on, check Logs tab (the banner prints Board/MQTT/Health)"
  echo "  5. Stop the ccx-bridge add-on if it is still running — one bridge per"
  echo "     broker, or their entities compete."
else
  echo "  3. Configuration tab → set ALL settings (pairings, Thread creds, etc.)"
  echo "     For MQTT/HA discovery set mqtt_url; leave empty to disable."
  echo "  4. Start the add-on, check Logs tab (the banner prints an MQTT: line)"
fi
