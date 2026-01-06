# Lutron Tools

Tools for hacking Lutron lighting systems: database extraction/modification for RadioRA3 and Homeworks project files, Clear Connect Type A RF transmission via ESPHome+CC1101, and a proxy to unlock Homeworks Programming in Lutron Designer.

## What's Here

- `db/lutron-tool.py` - Extract/repack `.ra3` and `.hw` project files
- `rf/lutron_cca/` - Clear Connect Type A protocol library
- `rf/esphome/` - ESP32 CC1101 transmitter (controls Caseta/RA2 Select without a bridge)
- `proxy/` - Designer API proxy for unlocking features

See `docs/` for protocol specs and research notes.
