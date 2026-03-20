#!/bin/sh
# HA add-on entrypoint — bridge reads /data/options.json directly

# Disable USB autosuspend for all USB devices (prevents dongle power-off)
for f in /sys/bus/usb/devices/*/power/autosuspend_delay_ms; do
  echo -1 > "$f" 2>/dev/null
done
for f in /sys/bus/usb/devices/*/power/control; do
  echo on > "$f" 2>/dev/null
done

exec npx tsx bridge/main.ts
