# Clear Connect X (CCX) Protocol Analysis

## Discovery: CCX is Thread

Analysis of Lutron RadioRA3/Homeworks databases reveals that **Clear Connect X (CCX) is based on Thread**, not proprietary RF like Clear Connect Type A (CCA).

**Evidence:**
- `fd00::` IPv6 prefixes indicate Thread/6LoWPAN Unique Local Addresses
- EUI-64 formatted addresses with `::ffff:fe` MAC derivation
- Standard 802.15.4 network parameters (PAN ID, Channel, Extended PAN ID)
- 16-byte AES-128 network master key

Thread is an 802.15.4-based mesh protocol that uses:
- IEEE 802.15.4 MAC layer (same as ZigBee)
- 6LoWPAN adaptation layer
- IPv6 network layer
- UDP/CoAP application layer (typically)

## Network Parameters (from database)

Extracted from `LinkNetwork` table:

| Parameter | Value | Notes |
|-----------|-------|-------|
| **Channel** | 25 | 2480 MHz (802.15.4 channel 25) |
| **PAN ID** | 25327 | 0x0000 in hex |
| **Extended PAN ID** | `XX:XX:XX:XX:XX:XX:XX:XX` | 8-byte network identifier |
| **Network Master Key** | `XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX` | 16-byte AES-128 key |

### Raw Database Row

```
LinkID:           234
Channel:          25
PanID:            25327
ExtendedPanId:    0x<your-thread-xpanid>
NetworkMasterKey: 0x00000000000000000000000000000000
LDKID:            00000000-0000-0000-0000-000000000000
Guid:             7BF6F1BA-D993-44C7-8037-8BDE3CCCE5F7
LDKNetworkMasterKey: NULL
```

## Device Table (LinkNode)

Extracted from `LinkNode` table. Devices with IPv6 addresses are Thread routers/always-on devices. NULL addresses are likely sleepy end devices (Picos, sensors).

| LinkNodeID | IPv6 Address | Derived MAC | GUID |
|------------|--------------|-------------|------|
| 233 | NULL | - | AFE52EB5-0A1C-4BF5-9473-E34361123952 |
| 640 | fd00::e406:bfff:fe9a:114f | E6:06:BF:9A:11:4F | 25BEE401-ACDA-4049-A342-C597EF4EB99B |
| 835 | fd00::f074:bfff:fe91:99f5 | F2:74:BF:91:99:F5 | BD48C3B4-292B-4094-B74D-0A09D755DCB7 |
| 928 | fd00::3c2e:f5ff:fef9:73f9 | 3E:2E:F5:F9:73:F9 | CA75B886-1726-4414-8403-ED3FDE56F16F |
| 1109 | fd00::8c8b:48ff:fe6a:473d | 8E:8B:48:6A:47:3D | B32EC10E-987C-4E4B-BBAA-08BD8CEAC3F0 |
| 1288 | NULL | - | 12D1B2F5-E584-4892-9E43-CDE341D64068 |
| 1307 | NULL | - | 987E3E5E-2302-434A-9AD6-88CA127C749F |
| 1356 | NULL | - | 8C3EB5EA-4073-4D72-8069-9A95FBDEDEC8 |
| 1461 | fd00::e079:8dff:fe93:456 | E2:79:8D:93:04:56 | ACAF9DB8-D90F-420F-B740-C109454ECACF |
| 1606 | NULL | - | A647F1A2-D3D1-40A0-AEFF-542F24025618 |
| 1683 | NULL | - | CBFCC1BD-1663-408B-A62E-2EFA04B7E0F5 |
| 1718 | NULL | - | B15194F3-F11A-4917-A5C5-4CB527332888 |
| 1734 | NULL | - | 2B6E19CB-DDE7-40C1-B6FF-47B9AEB3E1CB |

### MAC Address Derivation

Thread/6LoWPAN uses EUI-64 format for interface identifiers. To derive MAC from IPv6:

1. Take the last 64 bits of the IPv6 address
2. Remove the `ff:fe` in the middle
3. Flip bit 7 of the first byte

Example: `fd00::e406:bfff:fe9a:114f`
- Interface ID: `e406:bfff:fe9a:114f`
- Remove ff:fe: `e406:bf` + `9a:114f`
- Flip bit 7: `e4` → `e6`
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

Install the Wireshark plugin from the download package.

### 2. Configure Thread Decryption

**Edit → Preferences → Protocols → Thread**

| Setting | Value |
|---------|-------|
| Thread Master Key | `XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX` |

### 3. Configure IEEE 802.15.4 Decryption

**Edit → Preferences → Protocols → IEEE 802.15.4 → Decryption Keys → Edit**

Add key:
| Key | Key Index | Hash |
|-----|-----------|------|
| `XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX` | 0 | - |

### 4. Configure ZigBee Keys (backup)

**Edit → Preferences → Protocols → ZigBee**

Set Security Level: `AES-128 Encryption, 32-bit Integrity Protection`

Pre-configured keys:
```
# Standard Trust Center Link Key
5A:69:67:42:65:65:41:6C:6C:69:61:6E:63:65:30:39

# Lutron Network Key
XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX:XX
```

### 5. Capture Settings

- **Channel**: 25
- **Interface**: nRF52840 sniffer (or your 802.15.4 adapter)

### 6. Display Filters

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

1. **802.15.4 MAC frames** - Source/dest addresses, frame types
2. **6LoWPAN headers** - IPv6 header compression
3. **IPv6 packets** - fd00:: local addresses
4. **UDP datagrams** - Transport layer
5. **CoAP or proprietary** - Application layer (Lutron-specific)

The application layer commands will reveal how Lutron implements lighting control over Thread.

## Database Tables to Explore

Other potentially useful tables in the Lutron database:

| Table | Likely Contents |
|-------|-----------------|
| `LinkNetwork` | Network parameters (confirmed) |
| `LinkNode` | Device list (confirmed) |
| `LinkGroup` | Multicast groups |
| `LinkScene` | Scene definitions |
| `LinkBinding` | Device-to-device bindings |
| `LinkRoute` | Mesh routing tables |

## Comparison: CCA vs CCX

| Feature | Clear Connect A (CCA) | Clear Connect X (CCX) |
|---------|----------------------|----------------------|
| Frequency | 433 MHz | 2.4 GHz |
| Protocol | Proprietary | Thread (802.15.4) |
| Range | Long (433 MHz advantage) | Mesh extends range |
| Devices | Pico remotes, sensors | Dimmers, switches, processors |
| Network | Point-to-multipoint | IPv6 mesh |
| Encryption | Custom CRC/whitening | AES-128 (standard) |

## Next Steps

1. Acquire nRF52840 dongle
2. Configure Wireshark with keys above
3. Capture CCX traffic during device operations
4. Analyze application layer protocol
5. Document Lutron-specific CoAP/cluster commands
6. Investigate Matter compatibility (Thread is Matter transport)

## References

- [Zigbee2MQTT Sniffing Guide](https://www.zigbee2mqtt.io/advanced/zigbee/04_sniff_zigbee_traffic.html)
- [nRF Sniffer for 802.15.4](https://www.nordicsemi.com/Products/Development-tools/nRF-Sniffer-for-802154)
- [Thread Protocol Specification](https://www.threadgroup.org/technology)
- [Wireshark 802.15.4 Wiki](https://wiki.wireshark.org/IEEE_802.15.4)
