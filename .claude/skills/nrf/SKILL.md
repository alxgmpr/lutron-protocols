---
name: nrf
description: "nRF52840 USB dongle: flash sniffer or OpenThread RCP firmware, capture and analyze Thread/802.15.4 traffic. Use when asked to switch modes, capture packets, or reflash the dongle."
metadata:
  author: alexgompper
  version: "1.0.0"
  argument-hint: "<ot|sniffer|capture> [capture args...]"
user_invocable: false
---

# nRF52840 USB Dongle — Sniffer / RCP / Capture

This is the **standalone USB dongle** (NOT the NCP soldered to the Nucleo). It can run in two firmware modes and supports packet capture.

Usage: `/nrf ot`, `/nrf sniffer`, `/nrf capture [duration] [label]`

---

## Mode: OpenThread RCP (`/nrf ot`)

Flash with OpenThread RCP firmware and start ot-daemon to join the Lutron Thread network.

### Steps

#### 1. Put dongle in DFU bootloader mode
Press the **reset button** on the dongle. The LED will pulse red when in bootloader mode.
Wait for the user to confirm the dongle is in DFU mode.

#### 2. Find the DFU serial port
```bash
ls /dev/tty.usbmodem*
```

#### 3. Flash RCP firmware
Build the NCP/RCP firmware using the build script (clones OpenThread, applies Nucleo UART patch):
```bash
tools/nrf/ncp-build/build.sh
# Output: build/ot-ncp-ftd-nucleo.zip
```

Flash the DFU package:
```bash
nrfutil nrf5sdk-tools dfu usb-serial -pkg build/ot-ncp-ftd-nucleo.zip -p <PORT>
```

#### 4. Find the new serial port (changes after flash)
```bash
ls /dev/tty.usbmodem*
```

#### 5. Start ot-daemon
**User must run this in a separate terminal** (requires sudo for TUN interface):
```bash
sudo ~/bin/ot-daemon -I wpan0 -v 'spinel+hdlc+uart://<PORT>' --data-path /tmp/ot-data
```

#### 6. Configure and join Thread network
**User must run in another terminal** with sudo:
```bash
sudo ~/bin/ot-ctl -I utun<N>
```
The interface name is printed by ot-daemon (e.g., "Thread interface: utun8"). Then in the ot-ctl shell:
```
dataset clear
dataset channel 25
dataset panid <your-thread-panid>
dataset extpanid <your-thread-xpanid>
dataset networkkey <your-thread-master-key>
dataset commit active
ifconfig up
thread start
```
Wait ~5 seconds, then check: `state` — should show `router` or `child`.

#### 7. Ready
Once joined, you can:
- Ping devices: `ping fd0d:2ef:a82c::ff:fe00:<rloc>`
- Send CoAP via udp6 transport: `NUCLEO_HOST= bun run tools/ccx/ccx-coap-send.ts ...`
- Discover devices: `ping ff03::1`

### Key Facts (RCP mode)
- **Thread credentials**: channel 25, PAN ID <your-panid>, in .env file
- **ot-daemon binaries**: `~/bin/ot-daemon`, `~/bin/ot-ctl`
- **RCP firmware build**: `tools/nrf/ncp-build/build.sh` (clones ot-nrf528xx, applies patch, builds)
- **Socket**: `/tmp/openthread-utun<N>.sock` (auto-created by ot-daemon)

---

## Mode: 802.15.4 Sniffer (`/nrf sniffer`)

Flash with Nordic 802.15.4 sniffer firmware for capturing Thread/CCX traffic in Wireshark.

### Steps

#### 1. Kill ot-daemon if running
If ot-daemon is running, the user must Ctrl+C it in its terminal first.

#### 2. Put dongle in DFU bootloader mode
Press the **reset button** on the dongle. The LED will pulse red when in bootloader mode.
Wait for the user to confirm the dongle is in DFU mode.

#### 3. Find the DFU serial port
```bash
ls /dev/tty.usbmodem*
```

#### 4. Flash sniffer firmware
The DFU zip must be generated from the hex in the cloned repo:
```bash
# Clone repo if not present
ls ~/Downloads/nRF-Sniffer-for-802.15.4/nrf802154_sniffer/nrf802154_sniffer_nrf52840dongle.hex || \
  git clone https://github.com/NordicSemiconductor/nRF-Sniffer-for-802.15.4.git ~/Downloads/nRF-Sniffer-for-802.15.4

# Generate DFU zip from hex (only needed once)
ls ~/Downloads/nRF-Sniffer-for-802.15.4/nrf802154_sniffer_nrf52840dongle_dfu.zip || \
  nrfutil nrf5sdk-tools pkg generate --hw-version 52 --sd-req 0x00 --application-version 1 \
    --application ~/Downloads/nRF-Sniffer-for-802.15.4/nrf802154_sniffer/nrf802154_sniffer_nrf52840dongle.hex \
    ~/Downloads/nRF-Sniffer-for-802.15.4/nrf802154_sniffer_nrf52840dongle_dfu.zip

# Flash
nrfutil nrf5sdk-tools dfu usb-serial \
  -pkg ~/Downloads/nRF-Sniffer-for-802.15.4/nrf802154_sniffer_nrf52840dongle_dfu.zip \
  -p <PORT>
```

#### 5. Set up Python venv for extcap (only needed once)
```bash
ls ~/Downloads/nRF-Sniffer-for-802.15.4/venv/bin/activate || \
  (cd ~/Downloads/nRF-Sniffer-for-802.15.4 && python3 -m venv venv && source venv/bin/activate && pip install pyserial)
```

The Wireshark extcap script at `~/Library/Application Support/Wireshark/extcap/nrf802154_sniffer` sources this venv.

#### 6. Verify sniffer is detected
```bash
/Applications/Wireshark.app/Contents/MacOS/tshark -D 2>/dev/null | grep -i nrf
```
Or check serial ports:
```bash
ls /dev/cu.usbmodem*
```

### Key Facts (Sniffer mode)
- **Sniffer firmware source**: `https://github.com/NordicSemiconductor/nRF-Sniffer-for-802.15.4`
- **Channel**: 25 (configured in Wireshark GUI extcap preferences, not CLI)
- **Thread decryption keys**: `~/Library/Application Support/Wireshark/ieee802154_keys`
- **Extcap script**: `~/Library/Application Support/Wireshark/extcap/nrf802154_sniffer`
- **Python venv**: `~/Downloads/nRF-Sniffer-for-802.15.4/venv/`

---

## Capture & Analysis (`/nrf capture`)

Capture decrypted Thread/802.15.4 traffic. Requires sniffer firmware (see above).

### Prerequisites
- nRF 802154 Sniffer dongle plugged in (shows as `/dev/cu.usbmodem*` with product "nRF 802154 Sniffer")
- Wireshark installed at `/Applications/Wireshark.app` (provides tshark)
- Thread decryption keys configured in `~/Library/Application Support/Wireshark/ieee802154_keys`
- Channel 25 saved in Wireshark preferences (set via GUI once)

### Capture Commands

```bash
# Timed capture (recommended for Designer transfers — use 900s+ for full transfers)
tshark -i /dev/cu.usbmodem<ID> -w captures/ccx-<label>.pcapng -a duration:<seconds> -q

# Indefinite capture (Ctrl+C to stop)
tshark -i /dev/cu.usbmodem<ID> -w captures/ccx-<label>.pcapng -q

# Quick capture with live packet count
tshark -i /dev/cu.usbmodem<ID> -w captures/ccx-<label>.pcapng -a duration:<seconds>
```

### Analysis Commands

```bash
# Summary stats
tshark -r captures/<file>.pcapng -q -z io,stat,0

# CCX multicast traffic (port 9190)
tshark -r captures/<file>.pcapng -Y "udp.port == 9190" \
  -T fields -e frame.time_relative -e ipv6.src -e ipv6.dst -e udp.payload

# CoAP programming traffic (port 5683)
tshark -r captures/<file>.pcapng -d udp.port==5683,coap \
  -Y 'udp.port==5683 && coap.opt.uri_path_recon' \
  -T fields -e frame.time_relative -e ipv6.src -e ipv6.dst \
  -e coap.code -e coap.opt.uri_path_recon -e data

# CoAP with full details
tshark -r captures/<file>.pcapng -Y "coap" -V | head -200

# TMF traffic (port 61631)
tshark -r captures/<file>.pcapng -Y 'udp.port==61631' \
  -T fields -e frame.time_relative -e ipv6.src -e ipv6.dst -e data

# All unique IPv6 addresses
tshark -r captures/<file>.pcapng -T fields -e ipv6.src -e ipv6.dst | \
  tr '\t' '\n' | sort -u | grep -v '^$'

# Decode CCX CBOR payloads using our tool
bun run tools/ccx/ccx-sniffer.ts --file captures/<file>.pcapng

# Detailed CCX analysis
bun run tools/ccx/ccx-analyzer.ts --file captures/<file>.pcapng types
bun run tools/ccx/ccx-analyzer.ts --file captures/<file>.pcapng timeline
bun run tools/ccx/ccx-analyzer.ts --file captures/<file>.pcapng devices
```

### Key Facts (Capture)
- **CCX UDP port**: 9190 (multicast to ff03::1, CBOR-encoded)
- **CoAP port**: 5683 (unicast, used for programming/config)
- **Processor address**: fd00::ff:fe00:2c0c (RA3 processor)
- **Capture dir**: `captures/` in project root
- **Naming convention**: `ccx-<descriptive-label>.pcapng`

### Typical Workflows

**Designer Transfer Capture:**
1. Start capture: `tshark -i /dev/cu.usbmodem<ID> -w captures/ccx-designer-transfer.pcapng -q`
2. Open Designer, connect to processor, do full transfer
3. Wait for transfer to complete, press Ctrl+C
4. Analyze CoAP: `tshark -r captures/ccx-designer-transfer.pcapng -Y "coap"`

**Button Press Capture:**
1. Start capture: `tshark -i /dev/cu.usbmodem<ID> -w captures/ccx-button-test.pcapng -a duration:30 -q`
2. Press buttons on keypads during the 30 seconds
3. Decode: `bun run tools/ccx/ccx-sniffer.ts --file captures/ccx-button-test.pcapng`

### Troubleshooting
- **No packets**: Check sniffer is detected (`tshark -D | grep nrf`), verify channel 25 in Wireshark GUI
- **Encrypted payloads**: Thread keys missing or wrong seq — check `~/Library/Application Support/Wireshark/ieee802154_keys`
- **No CoAP**: CoAP is unicast between processor and devices — sniffer must be in radio range of both
- **Sniffer not found**: Port changes on replug — re-detect with `tshark -D`
