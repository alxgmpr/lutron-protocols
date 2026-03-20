---
name: nRF 802.15.4 sniffer serial protocol
description: Exact serial protocol for the nRF52840 sniffer dongle — init commands, output format, ANSI escape quirks
type: reference
---

The nRF 802.15.4 sniffer firmware uses a Zephyr shell over USB CDC ACM serial.

**Init sequence** (matches Nordic's Python extcap nrf802154_sniffer.py):
1. `sleep\r\n` — stop any active capture
2. `shell echo off\r\n` — disable command echo
3. (drain ~500ms — shell responses are discarded)
4. `channel <N>\r\n` — set 802.15.4 channel (11-26)
5. `receive\r\n` — start packet capture

**Output format:** `\x1b[Jreceived: <hex> power: <rssi> lqi: <lqi> time: <timestamp>\r\n`
- `\x1b[J` = ANSI "erase to end of display" (must strip before parsing)
- `<hex>` = raw 802.15.4 frame INCLUDING 2-byte FCS (must strip last 2 bytes)
- `<rssi>` = signed integer dBm
- `<lqi>` = 0-255
- `<timestamp>` = microseconds since device boot

**Shutdown:** `sleep\r\n` to stop capture before closing port.

**Reference:** Python extcap at `~/Downloads/nRF-Sniffer-for-802.15.4/nrf802154_sniffer/nrf802154_sniffer.py`
