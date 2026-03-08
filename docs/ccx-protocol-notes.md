# CCX Protocol Notes

Collected reverse-engineering notes for Clear Connect Type X (Thread/802.15.4) protocol.

## Protocol Overview

- 10 message types over UDP:9190, CBOR arrays
- Button encoding: CCX device_id bytes 0-1 = LEAP Preset ID (BE uint16)
- See `ccx/` directory for encoder/decoder/types/constants

## Thread Frame Decryption (RESOLVED 2026-03-05)

- **Key derivation**: `HMAC-SHA256(master_key, seq_BE || "Thread")` — the "Thread" suffix is critical!
- Bun does NOT support `aes-128-ccm` — must use Node.js
- Dimmer EUI-64: `22:0e:fb:79:b4:ce:f7:6f` → 0x6c06 (serial 0x0451A7A0, zone 3663)
- DEVICE_REPORT: `[27, {0: {0:1, 1:<level16>, 2:3}, 2: [1, serial]}]`
- Dimmer sends unicast to processor — sniff directly, processor does NOT re-multicast
- LEAP constructor: `new LeapConnection({ host, certName })` (object, not positional args)
- See `memory/ccx-thread-decryption.md` for full details

## Thread Network Injection (ACHIEVED 2026-02-13)

- **nRF52840 dongle can JOIN the Lutron Thread network and SEND commands**
- No pairing/commissioning needed — just network key + channel + PAN ID + extended PAN ID
- Devices accept commands from our dongle without additional auth!
- **Two modes**: RCP (USB dongle + ot-daemon) and NCP (soldered to STM32 via UART)
- **CCA threshold -45 dBm is REQUIRED** — default ~-75 dBm causes 100% TX failure (TxErrCca)

## CoAP Programming (RESOLVED 2026-03-06)

- **Send to device PRIMARY ML-EID** (random IID, discoverable via `ping ff03::1`)
- Path `/cg/db/ct/c/AHA` works, `/cg/db/pr/c/0070` does NOT (4.04)
- Device secondary ML-EID (EUI-64, `ff:fe` pattern, stored in Designer DB) is NOT reachable from nRF dongle — Thread address resolution doesn't know about them
- **AHA LED brightness**: `[108, {4: <active_level>, 5: <inactive_level>}]` (0-255)
- **13 keypads identified and mapped** — see `docs/ccx-device-map.md`
- Skills: `/nrf-ot` (flash RCP, join Thread), `/nrf-sniffer` (flash sniffer, capture)
- nRF dongle DFU: press reset → LED pulses red → `nrfutil nrf5sdk-tools dfu usb-serial`
- RCP firmware: `~/lutron-tools/src/ot-nrf528xx/build/nrf52840-usb/bin/ot-rcp`
- Sniffer firmware: `~/Downloads/nRF-Sniffer-for-802.15.4/nrf802154_sniffer_nrf52840dongle_dfu.zip`

## NCP TX (RESOLVED 2026-03-06)

- **NCP `Ip6::SendRaw()` does NOT compute UDP checksums** for STREAM_NET packets
- IPv6 mandates valid UDP checksum — devices silently drop checksum=0 packets
- Fix: parse mesh-local addr from IPv6 address table, set as src, compute checksum ourselves
- CCA threshold must be set BEFORE `ifconfig up` in `thread_join()`
- NCP LAST_STATUS=0 only means "accepted into queue", NOT "transmitted OTA"
- 7 retransmits at 80ms, on/off/level all confirmed working

## Fade & Delay Control (CONFIRMED 2026-02-13)

- **Command key 3 = fade time in quarter-seconds** (`key3 = seconds * 4`)
- **Command key 4 = delay time in quarter-seconds** (`key4 = seconds * 4`)
- Default fade = `1` (0.25s, instant). Delay omitted = no delay.
- Full LEVEL_CONTROL: `[0, { 0: {0: level, 3: fade, 4: delay}, 1: [16, zoneId], 5: seq }]`
- `tools/ccx-send.ts --fade <seconds> --delay <seconds>`
