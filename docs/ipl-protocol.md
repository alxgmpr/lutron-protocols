# IPL Protocol: RA3 Designer Integration Port (TLS:8902)

The RA3 processor exposes a binary protocol on TLS port 8902 used by Lutron Designer
for project transfer, device configuration, and real-time state sync. This document
covers the protocol framing, message types, and connection setup discovered through
reverse engineering.

**Date**: 2026-03-06
**Processor**: RA3 (HWQS), firmware v03.247, IP 10.0.0.1

---

## 1. Connection & TLS

The IPL server uses mutual TLS with a certificate chain separate from the LEAP API (port 8081).

### Server Certificate Chain

```
radioRa3-products (root, self-signed by lutron-root)
  └── radioRa3-devices
        └── radioRa3-processors-027-4725-24
              └── radiora3-a0b1c2d3e4f5-server (leaf, ECDSA P-256)
```

### Client Certificate Requirements

The processor requests client certs signed by:
```
CN=Lutron Project SubSystem Certificate Authority
O=Lutron Electronics Co., Inc.
ST=PA, C=US
```

This is a **project-level CA** — each Designer project generates its own SubSystem CA.
The CA cert + private key are stored in `cert_v2.pfx` on the Designer workstation.

### Certificate Extraction

Certs were extracted from the Lutron Designer Windows Store app:
```
C:\Program Files\WindowsApps\LutronElectronics.LutronDesignerGamma_26.0.2.100_x86__...\
  QuantumResi\BinDirectory\CertificateStore\
```

**Files found in Designer's CertificateStore:**

| File | Purpose |
|------|---------|
| `residential_local_access.pfx` | Generic residential GUI cert (signed by Designer CA, NOT accepted by processor) |
| `commercial_local_access.pfx` | Generic commercial GUI cert |
| `one_gui_local_access.pfx` | OneGUI interface cert |
| `radioRa3_products.crt` | RA3 product root CA (for server verification) |
| `homeworksqs_products.crt` | HWQS product root CA |
| `athena_products.crt` | Athena product CA |
| `myroom_products.crt` | MyRoom product CA |
| `quantum_products.crt` | Quantum product CA |

**Key finding**: The `residential_local_access.pfx` cert is signed by `CN=Lutron Designer Certificate Authority`,
but the processor expects `CN=Lutron Project SubSystem Certificate Authority`. These are different CAs.

The project-specific SubSystem CA was found separately at `C:\Users\alex\cert_v2.pfx` — this PFX
contains the CA's own certificate and private key (empty password, ECDSA P-384). Using this CA,
we generated a client cert that the processor accepts.

### Connection Setup

```bash
# Extract CA from PFX (empty password, legacy crypto)
openssl pkcs12 -in cert_v2.pfx -out cert_v2.pem -nodes -passin pass: -legacy

# Generate client key and cert
openssl ecparam -genkey -name secp384r1 -out ipl_client_key.pem
openssl req -new -key ipl_client_key.pem -out ipl_client.csr \
  -subj "/C=US/ST=PA/O=Lutron Electronics Co., Inc./CN=Designer Client"
openssl x509 -req -in ipl_client.csr -CA cert_v2_client.pem -CAkey cert_v2_key.pem \
  -CAcreateserial -out ipl_client_cert.pem -days 3650 -sha384

# Connect
openssl s_client -connect 10.0.0.1:8902 \
  -cert ipl_client_cert.pem -key ipl_client_key.pem -quiet
```

Cipher negotiated: **TLS_CHACHA20_POLY1305_SHA256** (TLSv1.3).

---

## 2. Protocol Framing

Messages are delimited by `LEI` + ASCII type byte markers. No explicit length field —
messages run from one marker to the next.

### Message Header (12 bytes)

```
Offset  Size  Field
0       3     Magic: "LEI"
3       1     Type: '@' (0x40), 'C' (0x43), 'E' (0x45), etc.
4       2     Version: 00 01 (always)
6       2     Flags: 00 FF (always)
8       2     Sequence: uint16 BE, monotonically increasing
10      2     Subtype: varies by message type
```

### Message Types

| Marker | Direction | Purpose | Subtype |
|--------|-----------|---------|---------|
| `LEI@` | Processor → Client | Commands (zlib JSON) or init handshake | `01 5D` for commands, `00 1C` for init |
| `LEIE` | Processor → Client | Status reports (binary) or heartbeat | `00 01` for status, `00 02` for init status |
| `LEIC` | Both | Keepalive / acknowledgment | `00 00` or `00 01` |

---

## 3. LEI@ — Command Messages

### RequestSetLEDState (most common)

The processor periodically sends LED state updates for button/keypad LEDs:

```
Header: LEI@ 00 01 00 FF <seq> 01 5D
Body:   00 3B "RequestSetLEDState" 00*6 <zlib>
```

The body starts with `00 3B` (null + semicolon), followed by the ASCII command name,
null-padded to 6-byte alignment, then a zlib-compressed JSON payload.

**JSON payload**: `{"ObjectId":<integration_id>,"State":0|1}`

Example decoded messages (30-second capture):
```json
{"ObjectId":1855,"State":0}    // LED off
{"ObjectId":491,"State":1}     // LED on
{"ObjectId":490,"State":0}     // LED off
{"ObjectId":1901,"State":1}    // LED on
```

The ObjectId values are LEAP button/LED integration IDs (2000+ range for most).
State toggles between 0 and 1 roughly every 5 seconds per cycle.

### Init/Handshake Message

```
Header: LEI@ 00 01 00 FF <seq> 00 1C
Body:   00 31 <49 bytes binary>
```

Sent once every ~6 cycles. Contains what appears to be a project identifier and timestamp.
The exact fields are not yet decoded. Example body:
```
00 31 08 67 63 08 06 67 A2 CB 40 C4 8C 43 A3 05
A4 ED 11 8C B4 D5 00 00 00 00 00 00 00 00 00 00
00 00 00 08 1B 01 00 00 00 00 00 1A 00 02 00 64
00 01 83 09
```

---

## 4. LEIE — Status Reports

Binary status messages reporting zone levels, device states, occupancy, and configs.

### Short Status Format (payload_len ≤ 9)

```
Offset  Size  Field
0       2     Payload length (uint16 BE)
2       2     Padding: 00 00
4       2     Object ID (uint16 BE) — LEAP integration ID
6       2     Property type (uint16 BE)
8       1-3   Value bytes
```

### Property Types

| Property | Meaning | Value Format | Example |
|----------|---------|-------------|---------|
| `0x000F` | Zone level (dimmer) | `<cmd> <level16:u16>` | `01 FE FF` = 100% |
| `0x0003` | Zone level (switch/fan) | `<cmd> <level16:u16>` | `01 00 00` = 0% |
| `0x0005` | Pico button state | `<val:u16>` | `7F 01` |
| `0x025B` | Area occupancy | `<state:u8>` | `00` or `01` |
| `0x0243` | Boolean state | `<val:u8>` | `00` or `FF` |
| `0x006B` | LED status | `<val:u16>` | `42 00` off, `42 01` on |

Level encoding matches LEAP/CCA: `level16 = percent * 0xFEFF / 100`.

### Long Status Format (payload_len > 9)

Two larger payload types observed:

**Config block 0x0225** (40 bytes): Timer/fade configuration
```
00 28 00 00 <obj_id> 02 25 00 00 <...timer data...>
```

**Config block 0x0202** (47 bytes): Device settings
```
00 2F 00 00 <obj_id> 02 02 00 00 <...settings data...>
```

### Heartbeat

Single-byte body (`00`), payload_len = 1. Sent frequently between status batches.

### Object ID Cross-Reference

Object IDs map directly to LEAP integration IDs:

| IPL Object ID | LEAP Entity | Name |
|---------------|-------------|------|
| 518 | `/zone/518` | Light |
| 546 | `/zone/546` | Standing Desk Lamps |
| 574 | `/zone/574` | Desk Lamps |
| 435 | `/device/435` | Processor 001 (HWQSProcessor) |
| 694 | `/device/694` | Pico4Button |
| 32 | `/area/32` | (area) |

---

## 5. LEIC — Keepalive

```
Header: LEIC 00 01 00 FF <seq> <00 00 | 00 01>
Body:   00 06 00 00 <obj_id:u16> 00 39
```

Two LEIC messages per cycle, alternating between two object IDs (e.g., 707 and 698).
The subtype toggles between `00 00` and `00 01`. The trailing `00 39` may be a fixed
command code.

---

## 6. Traffic Pattern

A typical 5-second cycle from the processor:

1. **LEIE heartbeats** (body=`00`, several per cycle)
2. **LEIC keepalive** (obj_id A)
3. **LEI@ RequestSetLEDState** (1-3 LED updates)
4. **LEIE status batch** (all zones: levels, occupancy, configs)
5. **LEIC keepalive** (obj_id B)
6. **LEIE status batch** (same zones, toggled ON/OFF state)

The state alternates each cycle — zones report 0% in odd cycles and their actual
level in even cycles. This appears to be a Designer UI refresh pattern rather than
actual state changes.

---

## 7. Protocol Behavior Notes

### Read-Only Sync
The IPL port appears to be primarily a **state sync channel** for Designer's UI.
Sending LEIE messages back to the processor causes them to be echoed but does NOT
change zone levels. Sending LEI@ with unknown command names either gets no response
or causes the processor to close the connection.

### Known Command Names (from Designer DLLs)

Strings extracted from `Lutron.Gulliver.Infrastructure.dll` (7.7MB .NET assembly):

| Command | Purpose |
|---------|---------|
| `RequestSetLEDState` | LED state sync (processor → client) |
| `RequestIPLProtocolVersion` | Query protocol version |
| `RequestSchemaVersion` | Query database schema version |
| `RequestDatabaseSync` | Trigger full database sync |
| `RequestDatabaseSyncInfo` | Get sync metadata |
| `RequestDeviceNotInDatabase` | Device discovery notification |
| `RequestDeviceTransferStatus` | Transfer progress |
| `RequestObjectTweaks` | Modify object properties |
| `RequestTweakChanges` | Apply pending tweaks |
| `RequestResendMany/One` | Request data retransmission |
| `RequestTelnetDiagnosticUser` | Diagnostic telnet access |
| `DeviceSetOutputLevel` | Set zone/output level |
| `EndTweakedDataExtraction` | Finalize tweak extraction |

### Init Handshake
The processor may require a proper init response before accepting commands. The init
message (body `00 31 ...`) likely contains session negotiation data. Without sending
the correct init response, command messages are silently ignored.

---

## 8. Comparison with LEAP API

| Feature | LEAP (8081) | IPL (8902) |
|---------|-------------|------------|
| Transport | JSON over TLS | Binary (LEI framing) + zlib JSON |
| Auth | LEAP certs (lutron-root CA) | Project SubSystem CA |
| Direction | Request/response | Mostly server push |
| Zone control | CreateRequest GoToLevel | DeviceSetOutputLevel (not yet working) |
| Device config | Caseta only (tuning, phase, etc.) | RequestObjectTweaks (not yet working) |
| Database | Per-endpoint reads | RequestDatabaseSync (full dump) |
| Real-time | Subscribe to events | Continuous state stream |

---

## 9. Tools

| Tool | Purpose |
|------|---------|
| `tools/ipl-client.ts` | Connect, decode, and display IPL traffic |
| `tools/leap-explore.ts` | Comprehensive LEAP endpoint scanner |
| `tools/leap-mitm.ts` | TLS MITM proxy (blocked by cert pinning) |
| `tools/leap-frida.js` | Frida TLS hook script (blocked by SIP) |
| `tools/leap-lldb-intercept.py` | LLDB TLS breakpoint script (blocked by hardened runtime) |

### IPL Client Usage

```bash
bun run tools/ipl-client.ts                    # Connect and show all messages
bun run tools/ipl-client.ts --quiet            # Only state changes + commands
bun run tools/ipl-client.ts --save             # Save raw + parsed data to data/
bun run tools/ipl-client.ts --host 10.0.0.1  # Specify processor IP
```

---

## 10. Certificate Files

All in `certs/designer/`:

| File | Source | Purpose |
|------|--------|---------|
| `cert_v2.pfx` | Windows VM | Project SubSystem CA (key + cert, empty password) |
| `cert_v2_client.pem` | Extracted | SubSystem CA cert (PEM) |
| `cert_v2_key.pem` | Extracted | SubSystem CA private key (PEM) |
| `ipl_client_cert.pem` | Generated | Our client cert (signed by SubSystem CA) |
| `ipl_client_key.pem` | Generated | Our client private key |
| `radioRa3_products.crt` | Designer | RA3 product root CA (server verification) |
| `residential_local_access.pfx` | Designer | Generic residential GUI cert (NOT accepted by processor) |
| `commercial_local_access.pfx` | Designer | Generic commercial GUI cert |
| `one_gui_local_access.pfx` | Designer | OneGUI interface cert |
| `proc_cert2.pfx` | Windows VM | Processor's own server cert |

---

## 11. Future Work

1. **Decompile Designer**: Use ILSpy/dnSpy on `ConnectSyncService.exe` and
   `Lutron.Gulliver.Infrastructure.dll` to find exact command formats
2. **Init handshake**: Reverse the `00 31` init message to properly establish
   a session before sending commands
3. **Database sync**: Try `RequestDatabaseSync` to pull the full project database
   (would reveal all device configs, scenes, schedules)
4. **Device config**: Find the correct format for `RequestObjectTweaks` to modify
   trim, phase, fade, and LED settings via IPL (these are hidden on RA3's LEAP API)
5. **Capture Designer traffic**: Mirror the processor's Ethernet during a Designer
   transfer to capture the full command sequence
