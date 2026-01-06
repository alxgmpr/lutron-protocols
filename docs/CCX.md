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

## Matter Compatibility

Thread is the transport layer for Matter. Future research could investigate:
- Whether Lutron CCX devices are Matter-compatible
- If the Thread network can be joined by Matter devices
- What application-layer protocol Lutron uses over Thread



