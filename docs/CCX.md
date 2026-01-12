# Lutron Clear Connect Type X (CCX) Protocol

## Discovery: CCX is Thread

Analysis of Lutron RadioRA3/Homeworks databases reveals that Clear Connect X (CCX) is based on Thread, not proprietary RF like Clear Connect Type A (CCA).

Evidence:
- `fd00::` IPv6 prefixes indicate Thread/6LoWPAN Unique Local Addresses
- EUI-64 formatted addresses with `::ffff:fe` MAC derivation
- Standard 802.15.4 network parameters (PAN ID, Channel, Extended PAN ID)
- 16-byte AES-128 network master key

Thread is an 802.15.4-based mesh protocol that uses:
- IEEE 802.15.4 MAC layer (same as ZigBee)
- 6LoWPAN adaptation layer
- IPv6 network layer
- UDP/CoAP application layer (typically)

## Protocol Comparison

| Feature | Clear Connect A (CCA) | Clear Connect X (CCX) |
|---------|----------------------|----------------------|
| Frequency | 433 MHz | 2.4 GHz |
| Protocol | Proprietary | Thread (802.15.4) |
| Range | Long (433 MHz advantage) | Mesh extends range |
| Devices | Pico remotes, sensors | Dimmers, switches, processors |
| Network | Point-to-multipoint | IPv6 mesh |
| Encryption | Custom CRC/whitening | AES-128 (standard) |

## Network Parameters

Extracted from `LinkNetwork` table in Lutron project database:

| Parameter | Example Value |
|-----------|---------------|
| Channel | 25 (2480 MHz) |
| PAN ID | 25327 (0x0000) |
| Extended PAN ID | XX:XX:XX:XX:XX:XX:XX:XX |
| Network Master Key | XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX |

## Device Table (LinkNode)

Devices with IPv6 addresses are Thread routers/always-on devices.
NULL addresses indicate sleepy end devices (Picos, sensors).

| LinkNodeID | IPv6 Address | Role |
|------------|--------------|------|
| 640 | fd00::e406:bfff:fe9a:114f | Router |
| 835 | fd00::f074:bfff:fe91:99f5 | Router |
| 233 | NULL | Sleepy end device |
| 1288 | NULL | Sleepy end device |

## MAC Address Derivation

Thread/6LoWPAN uses EUI-64 format. To derive MAC from IPv6:

1. Take the last 64 bits of the IPv6 address
2. Remove the `ff:fe` in the middle
3. Flip bit 7 of the first byte

Example: `fd00::e406:bfff:fe9a:114f`
- Interface ID: `e406:bfff:fe9a:114f`
- Remove ff:fe: `e406:bf` + `9a:114f`
- Flip bit 7: `e4` -> `e6`
- Result: `E6:06:BF:9A:11:4F`

## Sniffing Hardware

### Recommended: nRF52840 Dongle (~$15)

- Native 802.15.4 support
- Official Nordic Wireshark plugin
- Preferred Thread sniffer (Nordic is Thread contributor)
- Available from: Mouser, DigiKey, Amazon

### Alternative: CC2531 USB Dongle (~$10)

- Requires sniffer firmware flash
- Works with whsniff (Linux) or ZBOSS (Windows)
- Cheaper but more setup required

### Other Options

- HUSBZB-1 (~$45) - Works out of box
- Any 802.15.4 capable SDR

## Wireshark Configuration

### 1. Install nRF Sniffer for 802.15.4

Download from: https://www.nordicsemi.com/Products/Development-tools/nRF-Sniffer-for-802154

### 2. Configure Thread Decryption

Edit -> Preferences -> Protocols -> Thread

| Setting | Value |
|---------|-------|
| Thread Master Key | (from LinkNetwork table) |

### 3. Configure IEEE 802.15.4 Decryption

Edit -> Preferences -> Protocols -> IEEE 802.15.4 -> Decryption Keys -> Edit

Add the Network Master Key from your database.

### 4. Capture Settings

- Channel: (from LinkNetwork table, typically 25)
- Interface: nRF52840 sniffer

### 5. Display Filters

```
# All Thread traffic
thread

# All 802.15.4 traffic
wpan

# 6LoWPAN
6lowpan

# Specific PAN ID
wpan.dst_pan == 0xXXXX

# Specific device by MAC
wpan.src64 == e6:06:bf:9a:11:4f
```

## Expected Traffic

Once configured, you should see:

1. 802.15.4 MAC frames - Source/dest addresses, frame types
2. 6LoWPAN headers - IPv6 header compression
3. IPv6 packets - fd00:: local addresses
4. UDP datagrams - Transport layer
5. CoAP or proprietary - Application layer (Lutron-specific)

The application layer commands will reveal how Lutron implements lighting control over Thread.

## Database Tables

| Table | Contents |
|-------|----------|
| LinkNetwork | Network parameters (channel, PAN ID, keys) |
| LinkNode | Device list with IPv6 addresses |
| LinkGroup | Multicast groups |
| LinkScene | Scene definitions |
| LinkBinding | Device-to-device bindings |
| LinkRoute | Mesh routing tables |

## Extracting Keys from Project File

1. Extract .ra3 or .hw file (it's a ZIP archive)
2. Extract the .lut file (MTF backup format)
3. Attach the .mdf database to SQL Server 2022 RTM
4. Query: `SELECT * FROM LinkNetwork`

See `DATABASE_EDITING.md` for detailed extraction instructions.

## Application Layer Protocol (CBOR over UDP)

CCX uses **CBOR-encoded messages** over **UDP port 9190** for lighting control.

### Message Structure

All messages are CBOR arrays with 2 elements:
```
[msg_type, body_map]
```

### Message Types

| Type | Name | Description |
|------|------|-------------|
| 0 | Level Control | On/off, dimming commands (from app/Pico) |
| 1 | Button Press | Physical button/scene press on device |
| 7 | Acknowledgment | Response to commands |
| 41 | Status | Thread/device status updates |
| 65535 | Presence | Device broadcast/announcement |

### Level Control (Type 0) - Primary Command Format

```cbor
[0, {
    0: {
        0: <level>,     # 0xFEFF = ON (100%), 0x0000 = OFF (0%)
        3: 1            # Command subtype (always 1)
    },
    1: [<zone_type>, <zone_id>],  # e.g., [16, 961]
    5: <sequence>
}]
```

**Level Values** (LINEAR scale):
```
level = percent * 655.35
level = percent * (65535 / 100)
```

| Percent | Level (hex) | Level (dec) |
|---------|-------------|-------------|
| 0% | 0x0000 | 0 |
| 1% | 0x028F | 655 |
| 10% | 0x199A | 6554 |
| 25% | 0x4000 | 16384 |
| 50% | 0x8000 | 32768 |
| 75% | 0xBFFF | 49151 |
| 100% | 0xFFFF | 65535 |
| FULL ON | 0xFEFF | 65279 |

Note: `0xFEFF` ("full on") vs `0xFFFF` may distinguish "turn on" from "set to 100%"

**Zone Addressing**:
- `zone_type`: Usually 16 (may indicate device category)
- `zone_id`: Internal Lutron zone ID (e.g., 961)

**Example ON command** (hardware ID 0631acd7, zone 961):
```
Hex: 8200a300a20019feff03010182101903c105185c
Decoded: CCXLevelCommand(ON, level=100%, zone=961, seq=92)
```

**Example OFF command**:
```
Hex: 8200a300a2000003010182101903c105185d
Decoded: CCXLevelCommand(OFF, level=0%, zone=961, seq=93)
```

### Presence Broadcast (Type 65535)

Devices periodically broadcast presence messages:

```cbor
[65535, {
    4: 1,           # Status (1 = active?)
    5: <sequence>
}]
```

### Acknowledgment (Type 7)

```cbor
[7, {
    0: {
        1: {
            0: <response_bytes>
        }
    },
    5: <sequence>
}]
```

### Button Press (Type 1) - Physical Button/Scene

Triggered when a physical button is pressed on a Lutron device (keypad button, dimmer paddle).
The device broadcasts the button press, and the dimmer internally executes the associated scene.

```cbor
[1, {
    0: {
        0: <device_id>,       # 4 bytes: [cmd_type, zone_low, 0xEF, 0x20]
        1: [cnt1, cnt2, cnt3] # Frame counters (replay protection)
    },
    5: <sequence>
}]
```

**Device ID Format**: `[cmd_type, zone_low, 0xEF, 0x20]`
- Byte 0: Command type (0x03 = button press)
- Byte 1: Button/scene zone ID (low byte)
- Bytes 2-3: Fixed suffix `0xEF 0x20`

**Example** ("Relax" scene button sets light to 10%):
```
Hex: 8201a200a2004403b3ef2001831a0003e1483a0002fe66192c88051882
Decoded: CCXButtonPress(id=03b3ef20, zone=179, counters=[254280, -196199, 11400], seq=130)
```

**Key Observation**: Button presses don't contain level values. The scene/preset is stored
on the device itself. Pressing the button triggers the device to recall and execute its
stored scene configuration.

**ACK Response**: Button presses receive ACK with response byte `0x55` ('U'):
```
Hex: 8207a200a2000101a1004155051883
```

### Status Updates (Type 41)

Periodic status broadcasts from Thread devices containing device state:

```cbor
[41, {
    0: {
        0: 0,
        2: <status_payload>   # Raw status bytes
    },
    2: [type, device_id],     # Device identifier
    3: {1: <extra_field>}
}]
```

These appear at ~6 second intervals and may contain mesh routing or device health information.

### Sample ON/OFF Traffic

| Time | Seq | Type | Level | Zone | Description |
|------|-----|------|-------|------|-------------|
| 8.4s | 91 | 65535 | - | - | Presence broadcast |
| 24.3s | 92 | 0 | 0xFEFF | 961 | Turn ON |
| 29.3s | 93 | 0 | 0x0000 | 961 | Turn OFF |
| 33.2s | 94 | 0 | 0xFEFF | 961 | Turn ON |
| 37.1s | 95 | 0 | 0x0000 | 961 | Turn OFF |

Note: Commands are broadcast multiple times across the Thread mesh for reliability.

### Zone ID vs Hardware ID

The `zone_id` in CCX messages (e.g., 961) is an **internal Lutron index**, not the hardware serial number. The hardware ID (e.g., `0631acd7`) is stored in the Lutron database `LinkNode` table and maps to the zone ID.

### Wireshark Filter for Lutron Traffic

```
udp.port == 9190
```

### Python Decoder

See `ccx/ccx_decoder.py` for a Python implementation:

```python
from ccx.ccx_decoder import decode_and_parse

# Decode a level control command (from app/Pico)
cmd = decode_and_parse("8200a300a20019feff03010182101903c105185c")
print(cmd)  # CCXLevelCommand(FULL_ON, level=0xfeff, zone=961, seq=92)

# Decode a physical button press
btn = decode_and_parse("8201a200a2004403b3ef2001831a0003e1483a0002fe66192c88051882")
print(btn)  # CCXButtonPress(id=03b3ef20, zone=179, counters=[...], seq=130)
```

## Matter Compatibility

Thread is the transport layer for Matter. Future research could investigate:
- Whether Lutron CCX devices are Matter-compatible
- If the Thread network can be joined by Matter devices
- What application-layer protocol Lutron uses over Thread



