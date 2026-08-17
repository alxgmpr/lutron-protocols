#!/bin/sh
# HA add-on entrypoint — the bridge reads /data/options.json directly.
#
# No USB autosuspend fiddling here, unlike the sniffer add-on: there is no
# dongle on this path. The radios are on the openlutron board, reached over the
# network.

exec npx tsx bridge/openlutron-main.ts
