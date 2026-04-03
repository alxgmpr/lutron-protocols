# Vive RMJS Pairing Research

Pairing a Lutron Vive RMJS-8T-DV-B dimmer (serial `0x021F93A0`) to an RA3 processor (serial `0xXXXXXXXX`, subnet `0x82D7`) using our Nucleo STM32 CCA transceiver as a pairing proxy.

## Beacon and Response Types

Real Vive hubs send **BB beacons** (not B9). B9 is used for the accept step. Beacon format is `0x11`, with timer byte 24 = `0x3C` (active scanning) or `0x00` (stop). CC padding throughout.

### RMJS response depends on beacon source

The RMJS distinguishes who is scanning and responds differently:

| Beacon source | RMJS response | Format | pair_state | Addressing |
|---------------|--------------|--------|------------|------------|
| Real Vive hub (`YYYYYYYY`) | B8 announce | `0x23` | `0x00` (unpaired) | Broadcast |
| Our Nucleo (`XXXXXXXX`) | B9 announce | `0x26` | `0x01` (paired) | Directed |

## Full Vive Pairing Sequence

Captured from real Vive hub `YYYYYYYY` pairing the RMJS:

1. **BB beacons** (format `0x11`) -- 9 packets, ~100ms apart
2. **B8 announce** from device (format `0x23`)
3. **B9 accept** from hub (format `0x10`) -- directed to device
4. **Config format `0x13`** -- dimming capability
5. **Config format `0x28`** -- zone assignment A (byte 10 = `zone_byte + 0x28`)
6. **Config format `0x14`** -- function mapping
7. **Config format `0x28`** -- zone assignment B (byte 10 = `zone_byte + 0x2A`)
8. **Config format `0x12`** -- final config (byte 24 = zone_byte, authoritative)
9. **Device sends `0x8A` button presses** confirming pairing
10. **BB stop beacons** (timer = `0x00`)

## Addressing Model: Vive vs Bridge

### Vive (link type 30)

hub_id (4 bytes) + zone_byte. Commands use types `0x89`/`0x8A`/`0x8B` with hub_id at bytes 2-5, zone at byte 12.

### Bridge/RA3 (link type 9)

subnet (2 bytes) + zone. Commands use types `0x81`/`0x82`/`0x83` with zone_id at bytes 2-5 (encoded as `[flags][subnet:2][zone]`), target_id at bytes 9-12.

## Experiment Results

| Test | Result |
|------|--------|
| Vive-format SET_LEVEL with correct hub_id | WORKS |
| Bridge-format SET_LEVEL with any addressing | DOES NOT WORK |

**Conclusion**: A Vive-paired RMJS only responds to Vive-format commands (`0x89`/`0x8A`/`0x8B` with hub_id addressing). Bridge-format commands (`0x81`/`0x82`/`0x83` with subnet addressing) are ignored.

## Firmware Bugs Found and Fixed

### 1. TX_UNDERFLOW timeout

`cc1101_transmit_raw` spin-wait didn't check for MARCSTATE `0x16` (TX_UNDERFLOW) which occurs on all >64-byte encoded packets (infinite-length TX mode). Caused 200ms timeout per long packet. Fixed by checking for all non-TX states.

### 2. Stale GDO0 notification

During TX, GDO0 asserts on sync word sent, posting a task notification. The drain loop then burned 18ms per TX cycle waiting for RX data. Fixed by clearing stale notifications after TDMA poll.

### 3. Missing flush_rx_pending

Blocking pairing code called `cc1101_check_rx()` but never flushed pending packets, so RX hooks never fired. Fixed by adding `cca_flush_rx()` public API.

### 4. Protocol corrections

- Wrong beacon type: B9 changed to BB
- Wrong accept type: BA changed to B9
- Wrong padding: `0x00` changed to `0xCC`
- RX hook only checked B8 -- RMJS sends B9 format `0x26`

## Hypothesis: Subnet Pairing

Vive hubs use "pico-style" direct pairing (hub_id + zone). RA3/Caseta/Homeworks use "subnet-style" pairing (bridge beacons `0x91`/`0x93`, challenge/response, CCA transfer format `0x25` with device table).

The RMJS hardware (CC110L radio) is identical to bridge-paired dimmers. The protocol it speaks is likely determined by the programming sequence during pairing, not by hardware.

### Next experiments

1. After Vive-pairing, send RA3 CCA transfer (format `0x25`, byte 6 = `0x7F`) with RMJS serial in device list. See if the device accepts subnet programming on top of Vive pairing.
2. Put RMJS in pairing mode and send bridge-style `0x91`/`0x93` beacons instead of BB beacons. See if the RMJS responds with bridge-style challenge/response instead of Vive B8/B9 announce.
3. Capture what the RA3 coprocessor sends during CCA activation mode (Designer transfer) and replay that to a Vive-paired RMJS.

## Network / Hardware Reference

| Device | Identity | Notes |
|--------|----------|-------|
| Nucleo | 10.0.0.3 (UDP 9433) | STM32H723 + CC1101 transceiver |
| RA3 processor | 10.0.0.1 (root SSH) | Serial `0xXXXXXXXX`, subnet `0x82D7` |
| Vive hub | Serial `YYYYYYYY` | Link type 30 |
| RMJS dimmer | Serial `021F93A0` | RMJS-8T-DV-B |
| RA3 CCA wire identity | `A182D700` | Subnet `82D7` |

## Working Commands

```
cca vive-pair A182D700 13 30      # Pair RMJS (put in pairing mode first)
cca vive-level A182D700 13 100    # Set level
cca vive-level A182D700 13 0      # Turn off
```
