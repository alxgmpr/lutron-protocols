#!/bin/sh
# HA add-on entrypoint: read options.json → export env → exec bridge

OPTIONS_FILE="/data/options.json"

if [ -f "$OPTIONS_FILE" ]; then
  CHANNEL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$OPTIONS_FILE','utf8')).thread_channel || '')")
  MASTER_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$OPTIONS_FILE','utf8')).thread_master_key || '')")

  if [ -n "$CHANNEL" ] && [ "$CHANNEL" != "0" ]; then
    export THREAD_CHANNEL="$CHANNEL"
  fi
  if [ -n "$MASTER_KEY" ]; then
    export THREAD_MASTER_KEY="$MASTER_KEY"
  fi
fi

echo "[ha-addon] CCX_DATA_DIR=$CCX_DATA_DIR"
echo "[ha-addon] CCX_CONFIG_PATH=$CCX_CONFIG_PATH"
echo "[ha-addon] SNIFFER_DEVICE=$SNIFFER_DEVICE"
echo "[ha-addon] THREAD_CHANNEL=${THREAD_CHANNEL:-<from LEAP data>}"
echo "[ha-addon] THREAD_MASTER_KEY=${THREAD_MASTER_KEY:+set (hidden)}"

exec npx tsx bridge/main.ts
