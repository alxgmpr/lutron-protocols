# CCX Thread Network Injection — nRF52840 Setup

## Overview (ACHIEVED 2026-02-13)

An nRF52840 USB dongle can join the Lutron RA3 Thread (CCX) network and send
arbitrary LEVEL_CONTROL commands. Lights respond immediately. No pairing or
commissioning needed — just the network credentials from the LinkNetwork DB table.

## Architecture: RCP (NOT NCP)

- **NCP + wpantund is DEPRECATED** — do not use
- **RCP (Radio Co-Processor)** is the correct approach:
  - nRF52840 runs minimal radio firmware (ot-rcp)
  - Mac runs `ot-daemon` (full OpenThread stack)
  - `ot-ctl` is the CLI controller
- This is better for scripting — everything runs on the Mac

## Hardware

- Nordic nRF52840 USB Dongle (PCA10059), ~$15
- Has built-in USB DFU bootloader (press RESET button to enter)

## Build & Flash (one-time setup)

### Prerequisites
```bash
brew install --cask gcc-arm-embedded   # NOT brew formula — needs nano.specs
brew install cmake ninja
# nrfutil from nordicsemi.com + `nrfutil install nrf5sdk-tools`
```

**CRITICAL**: The Homebrew `arm-none-eabi-gcc` formula is MISSING `nano.specs`.
Must use `brew install --cask gcc-arm-embedded` which installs to
`/Applications/ArmGNUToolchain/`. Add to PATH before building:
```bash
export PATH="/Applications/ArmGNUToolchain/15.2.rel1/arm-none-eabi/bin:$PATH"
```

### Build RCP Firmware
```bash
cd lutron-tools/src
git clone --recursive https://github.com/openthread/ot-nrf528xx.git
cd ot-nrf528xx
# bootstrap will fail on brew tap conflict — that's OK, deps already installed
./script/build nrf52840 USB_trans -DOT_BOOTLOADER=USB
```

### Create DFU Package & Flash
```bash
cd build/bin
arm-none-eabi-objcopy -O ihex ot-rcp ot-rcp.hex
nrfutil nrf5sdk-tools pkg generate \
    --hw-version 52 --sd-req=0x00 \
    --application ot-rcp.hex --application-version 1 \
    ot-rcp-dfu.zip

# Press RESET on dongle (side button, push toward USB) — red LED pulses
nrfutil nrf5sdk-tools dfu usb-serial \
    --package ot-rcp-dfu.zip \
    --port /dev/cu.usbmodemXXXX
```

### Build ot-daemon + ot-ctl
Uses the OpenThread submodule already cloned inside ot-nrf528xx:
```bash
cd lutron-tools/src/ot-nrf528xx/openthread
./script/cmake-build posix -DOT_DAEMON=ON
```

Binaries at:
- `build/posix/src/posix/ot-daemon`
- `build/posix/src/posix/ot-ctl`

## Running

### Terminal 1: Start daemon
```bash
sudo ./src/ot-nrf528xx/openthread/build/posix/src/posix/ot-daemon -v \
    'spinel+hdlc+uart:///dev/cu.usbmodemXXXX?uart-baudrate=460800'
```

### Terminal 2: ot-ctl
```bash
sudo ./src/ot-nrf528xx/openthread/build/posix/src/posix/ot-ctl -I utun8
```
(Socket is at `/tmp/openthread-utun8.sock` — check `ls /tmp/openthread-*.sock`)

### Join Lutron Network (enter one at a time)
```
factoryreset
ccathreshold -45
dataset networkkey <your-thread-master-key>
dataset channel 25
dataset panid 0xXXXX
dataset extpanid <your-thread-xpanid>
dataset commit active
ifconfig up
thread start
```

Wait ~10-30s, verify:
```
state          # should show "child" or "router"
ipaddr         # should show fd00:: addresses
counters mac   # TxErrCca should be 0, RxTotal > 0
```

### Send Commands
```
udp open
udp send ff03::1 9190 -x 8200a300a20019feff03010182101903c105185c
```
(That's LEVEL_CONTROL ON for zone 961)

## Critical Gotchas

### CCA Threshold (THE KEY BLOCKER)
- **`ccathreshold -45` is REQUIRED** — without it, ALL transmissions fail
- Default CCA threshold is too sensitive (~-75 dBm)
- 2.4 GHz WiFi background noise (~-67 dBm) triggers CCA on every TX attempt
- Symptoms: `TxErrCca` = `TxTotal`, `RxTotal: 0`, state stuck at `detached`
- Must set BEFORE `ifconfig up` / `thread start`

### Network Name
- Lutron DB has NetworkName as EMPTY — don't set `dataset networkname` at all
- Setting a wrong name (e.g., "Lutron") doesn't seem to prevent joining
  but leaving it default is cleanest

### Mesh-Local Prefix
- Lutron uses `fd00::/64` — OpenThread default is `fdde:ad00:beef::/64`
- We did NOT need to set it manually — it's learned from the network leader after joining
- `dataset meshlocalprefix fd00::/64` has parser issues — avoid

### ifconfig down Kills Everything
- `ifconfig down` destroys the TUN interface, which kills `ot-daemon`
- Use `thread stop` instead if you need to stop Thread
- If daemon dies, must restart it in Terminal 1

### Multicast Commands
- All Lutron CCX commands go to multicast `ff03::1` on UDP port 9190
- CBOR-encoded arrays: `[msg_type, body_map]`
- Devices respond without checking the source — no auth beyond network key

## Lutron Network Credentials (from LinkNetwork DB table)
- Channel: 25
- PAN ID: 0xXXXX
- Extended PAN ID: <your-thread-xpanid>
- Network Key: <your-thread-master-key>
- Network Name: (empty in DB)

## Next Steps
- Build TypeScript tool to construct CBOR commands and send via ot-ctl
- Test all 10 CCX message types (LEVEL_CONTROL, SCENE_RECALL, etc.)
- Test fade time control in CCX (byte in LEVEL_CONTROL CBOR?)
- Possibly script ot-ctl via the Unix socket directly
