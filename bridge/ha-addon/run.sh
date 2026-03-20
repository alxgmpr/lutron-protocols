#!/bin/sh
# HA add-on entrypoint: read options.json → export env → exec bridge

OPTIONS_FILE="/data/options.json"

if [ -f "$OPTIONS_FILE" ]; then
  # Helper: read a key from options.json
  opt() { node -e "const o=JSON.parse(require('fs').readFileSync('$OPTIONS_FILE','utf8'));const v=o['$1'];if(v!==undefined&&v!=='')console.log(v)"; }

  CHANNEL=$(opt thread_channel)
  MASTER_KEY=$(opt thread_master_key)
  WARM_DIM=$(opt warm_dimming)
  WARM_DIM_CURVE=$(opt warm_dim_curve)
  WIZ_DIM_SCALING=$(opt wiz_dim_scaling)
  WIZ_PORT=$(opt wiz_port)
  DEVICE=$(opt sniffer_device)

  [ -n "$CHANNEL" ] && [ "$CHANNEL" != "0" ] && export THREAD_CHANNEL="$CHANNEL"
  [ -n "$MASTER_KEY" ] && export THREAD_MASTER_KEY="$MASTER_KEY"
  [ -n "$WARM_DIM" ] && export BRIDGE_WARM_DIMMING="$WARM_DIM"
  [ -n "$WARM_DIM_CURVE" ] && export BRIDGE_WARM_DIM_CURVE="$WARM_DIM_CURVE"
  [ -n "$WIZ_DIM_SCALING" ] && export BRIDGE_WIZ_DIM_SCALING="$WIZ_DIM_SCALING"
  [ -n "$WIZ_PORT" ] && export BRIDGE_WIZ_PORT="$WIZ_PORT"
  [ -n "$DEVICE" ] && export SNIFFER_DEVICE="$DEVICE"
fi

echo "[ha-addon] CCX_DATA_DIR=$CCX_DATA_DIR"
echo "[ha-addon] CCX_CONFIG_PATH=$CCX_CONFIG_PATH"
echo "[ha-addon] SNIFFER_DEVICE=$SNIFFER_DEVICE"
echo "[ha-addon] THREAD_CHANNEL=${THREAD_CHANNEL:-<from LEAP data>}"
echo "[ha-addon] THREAD_MASTER_KEY=${THREAD_MASTER_KEY:+set (hidden)}"
echo "[ha-addon] BRIDGE_WARM_DIMMING=${BRIDGE_WARM_DIMMING:-<from config>}"
echo "[ha-addon] BRIDGE_WARM_DIM_CURVE=${BRIDGE_WARM_DIM_CURVE:-<from config>}"
echo "[ha-addon] BRIDGE_WIZ_DIM_SCALING=${BRIDGE_WIZ_DIM_SCALING:-<from config>}"
echo "[ha-addon] BRIDGE_WIZ_PORT=${BRIDGE_WIZ_PORT:-<from config>}"

exec npx tsx bridge/main.ts
