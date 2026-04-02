# Lutron BLE Commissioning — Reverse Engineering Analysis

## Source: Lutron iOS App v26.0.0

Binary analysis of `BLEActivationFramework.framework`, `KMMUnifiedBackend.framework`,
`CommunicationFramework.framework`, and `CommandsFramework.framework`.

## Executive Summary

Lutron CCX device commissioning uses **BLE GATT over TLS** to deliver the Thread
Network Master Key (NMK) to new devices. The app establishes a TLS 1.2 session
tunneled through BLE GATT characteristics using HDLC framing, then sends the NMK
and post-NMK claiming data. There is an **"OOB without authentication"** code path
that skips certificate validation — this is our best attack surface.

## BLE Service Architecture

### Services Discovered on Device

| Service | Purpose |
|---------|---------|
| `DeviceInfoService` | Read-only: serial, model, firmware version |
| `ClaimingService` | Claiming/unclaiming device ownership |
| `ControlService` | Runtime control (levels, scenes) |
| `TLSService` | TLS tunnel for NMK delivery |
| `DeviceDiagnosticService` | Diagnostics/debug |
| `OrionClaimingService` | Alternate claiming (Ketra/Orion devices) |

### Characteristic Types

```
BLERRawCharacteristic       — Read raw bytes
BLEWRawCharacteristic       — Write raw bytes
BLERStringCharacteristic    — Read string
BLEWStringCharacteristic    — Write string
BLERUInt16Characteristic    — Read uint16
BLEWUInt16Characteristic    — Write uint16
BLERUInt32Characteristic    — Read uint32
BLEWUInt32Characteristic    — Write uint32
BLERUInt64Characteristic    — Read uint64
BLEWUInt64Characteristic    — Write uint64
BLEWBoolCharacteristic      — Write bool
BLEWUInt8Characteristic     — Write uint8
BLERWDateCharacteristic     — Read/write date
BLERWUUIDCharacteristic     — Read/write UUID
```

## TLS Over GATT Transport (GATTTLSManager)

### Architecture

```
┌─────────────┐     BLE GATT      ┌──────────────┐
│   iOS App    │◄────────────────►│  Lutron Device│
│              │                   │              │
│  TCP Client  │◄─── loopback ───►│  TCP Server   │
│  (TLS wrap)  │    localhost:N    │  (port scan   │
│              │                   │   49152+)     │
│  GATTTLSMgr  │                   │              │
│  ┌─────────┐ │                   │              │
│  │HDLCEnc  │ │                   │              │
│  └─────────┘ │                   │              │
└─────────────┘                   └──────────────┘
```

The app uses a **TCP loopback tunnel** to bridge Apple's TLS APIs with BLE:

1. `setupTCPEndpoints(startPort:endPort:)` — binds a local TCP server on ports 49152+
2. A TCP client connects to the local server
3. The client socket is wrapped in TLS using `TLSClientWrapper`
4. `TLSClientWrapper` is initialized with:
   - `certChainPaths:` — Array of certificate chain file paths
   - `acceptInvalidCerts:` — Boolean flag to bypass cert validation!
5. TLS plaintext ↔ HDLC framing ↔ BLE GATT read/write

### Data Flow

**Write (app → device):**
```
writeTLS(data:) → TLS encrypt → HDLC encode → BLE write characteristic
```

**Read (device → app):**
```
BLE read notification → forwardRead() → HDLC decode → TLS decrypt → readTLS(length:)
```

### Key Functions

- `GATTTLSManager.writeTLS(data:)` — async, writes through TLS
- `GATTTLSManager.writeTLS(_:completion:)` — callback version
- `GATTTLSManager.readTLS(length:)` — reads decrypted data
- `GATTTLSManager.forwardAllWrites()` — flushes pending GATT writes
- `GATTTLSManager.forwardReady(_:CBCharacteristic)` — handles BLE ready-to-send
- `GATTTLSManager.resetTLS()` — tear down and re-establish
- `GATTTLSManager.disconnect()` — clean shutdown
- `HDLCEncoder` — HDLC framing for BLE transport

### Certificate Chain

- `KetraBLEcertChain` — embedded certificate chain resource name
- `allowNonProdCerts` — flag to allow non-production certificates
- `acceptInvalidCerts` — flag to skip cert validation entirely

## NMK (Network Master Key) Delivery

### Commissioning Flow

```
1. App discovers device via BLE advertisement
   - advertisementUUID(rssiThreshold:timeout:brightness:isDiagnosticMode:workflowMode:deviceSet:)
   - advertisementClaimingStatus: claimed | unclaimed

2. App reads device info (ClaimingService + DeviceInfoService)
   - Serial number, model, firmware
   - OOB supported features
   - Claiming status

3. OOB type selection
   - sendOOBTypeSelectionCommand(device:selectedType:completion:)
   - "The app only supports OOB without authentication"
   - If device doesn't support our OOB method: "Dosen't support our OOB method. Supported: <list>"

4. OOB authentication (if needed)
   - sendOOBAuthenticateCommand(device:password:completion:)
   - For OOB-without-auth: performOOBWithoutAuthentication(device:completion:)
   - "Successfully OOBed device without authentication"

5. Establish TLS session
   - GATTTLSManager creates TCP loopback → TLS → HDLC → BLE GATT
   - Uses KetraBLEcertChain or allowNonProdCerts

6. Write NMK
   - nmkHeader: Foundation.Data (static header bytes)
   - "Writing NMK via secure BLE"
   - "Secure NMK write success" or "Secure NMK write failed with error: "

7. Verify NMK
   - verifyNMKResponse(lutBleDevice:ccxLinkProperties:ccxNoSelfActivationTimeout:completion:)
   - successfulNMKInjectionResponse: Foundation.Data (expected response bytes)
   - "Secure NMK status response failed" or "Unexpected secure NMK status response: "

8. Post-NMK claiming
   - postNMKStuff(lutBLEDevice:ccxLinkProperties:ccxNoSelfActivationTimeout:completion:)
   - "Writing non-NMK claim info"
   - Claim device with claimerGUID

9. Read assignment data over BLE
   - fetchAssignmentData(analyticsHelper:)
   - "Got assignment data over ble like "
   - BLE commands: getJoinerCredsCommand, getJoinerIdCommand,
     getNetworkListCommand, getStaticAddressCommand
```

### Key Data Read Over BLE

After NMK injection, the app reads:
- **joinerCredentials** / **joinerCred** — Thread joiner PSKd
- **joinerID** / **joinerIID** — Thread joiner ID
- **networkList** — Available Thread networks
- **staticAddress** — Device's static IPv6 address
- **assignmentData** — Full config blob

### Parameters to NMK Delivery

- `ccxLinkProperties` — Thread network properties (from LEAP `/link/234`)
  - Contains: NetworkMasterKey, channel, PAN ID, extended PAN ID, mesh-local prefix
- `ccxNoSelfActivationTimeout` — Timeout for self-activation

## LEAP Commissioning Endpoints

### Device Discovery & Activation

```
LeapRequestBeginUnassociatedDeviceDiscoveryCommand
  — Start scanning for unpaired devices (power cycle discovery)

AddressDeviceCommand
  — createAndExecuteAddressDeviceRequestForHref:serialNumber:ipAddress:deviceClass:clientTag:andFormat:
  — Associates device with processor by serial number

UnaddressDeviceCommand
  — createAndExecuteUnaddressDeviceRequestForHref:clientTag:isDeviceOffline:andFormat:
  — Removes device from processor

DeviceAddCommand
  — deviceAddRequestForDeviceName:associatedAreaHref:serialNumber:sessionHref:userRef:timeOfActivation:andClientTag:
  — Adds new device to project

DeviceActivationCommand
  — deviceActivationRequestForActiveMode:andClientTag:

DeviceExtractionCommand / DeviceExtractionCancelCommand
  — For extracting device from system

DeviceRetryCommand
  — deviceRetryRequestWithForce:andClientTag:deviceHrefs:
```

### Transfer Session (Config Push to Device)

```
LeapBeginTransferSessionCommand
  — beginTransferSessionCommandBody
  — BeginTransferSessionParameters
  — Initiates config transfer to device (triggers CoAP programming burst)

LeapCloudProvisionCommand
  — cloudProvisionCommandBody
  — Cloud-side provisioning
```

### CCX Link Properties

```kotlin
KMMUBLeapCcxLinkProperties     // CCX (Thread) link config
KMMUBLeapCcaLinkProperties     // CCA (433MHz) link config
KMMUBLeapLinkCCX               // CCX link object
KMMUBLeapLinkCCA               // CCA link object

// Link init parameters:
initWithHref:LinkNumber:ClearConnectTypeXLinkProperties:
```

### All LEAP URL Types (from declarationExports)

| URL Type | Purpose |
|----------|---------|
| `areaUrl` | Area management |
| `buttonGroupUrl` | Button group config |
| `buttonUrl` | Individual button config |
| `deviceUrl` | Device management |
| `facadeUrl` | Shade facade config |
| `networkInterfaceHref` | Network interface config |
| `occupancygroupUrl` | Occupancy groups |
| `serverUrl` | Server/processor status |
| `serviceUrl` | Cloud services |
| `systemUrl` | System-wide settings |
| `systemActionUrl` | System actions (away, etc.) |
| `systemAwayUrl` | Away mode |
| `systemNaturallightoptimizationUrl` | NLO (daylight) |
| `timeclockUrl` | Time clock events |
| `virtualbuttonUrl` | Virtual buttons |
| `zoneUrl` | Zone level control |
| `zoneStatusUrl` | Zone status subscription |
| `programmingModelHref` | Programming model |
| `projectContactinfoUrl` | Project contacts |
| `presetHrefDimmedlevelassignment` | Dimmer preset |
| `presetHrefSwitchedlevelassignment` | Switch preset |
| `presetHrefShadelevelassignment` | Shade preset |
| `presetHrefTiltassignment` | Tilt preset |

### Known Sub-URL Patterns

```
/server/1/status/ping
/clientsetting
/link/{id}/associatedlinknode
/link/{id}/associatedlinknode/expanded
/area/{id}/associatedzone/status/expanded
/area/{id}/childarea/areascene
/preset/{id}/dimmedlevelassignment
/preset/{id}/switchedlevelassignment
/preset/{id}/shadelevelassignment
/timeclock/{id}/timeclockevent
```

## Supported Device Types

From BLE strings:
- `sunnataKeypad`
- `sunnataHybridKeypad`
- `sunnataFanControl`
- `viertiKeypad`
- `viertiKeypad2Col`
- `tapeLightController`

From KMMUnifiedBackend:
- `BleDeviceSystemType` — enum of device hardware types
- `BleFormFactor` — physical form factor enum
- `BleMode` — BLE operational mode enum
- `DiscoverableDeviceCategory` — discovery classification

## Key Code Identifiers (from KMMUnifiedBackend)

```
kek KEK kek NYM xek NKK afk DOK rfk CAK xfk LUK yfk NMK egk
nlk LAK bmk NBM nmk
```

These appear to be **key type identifiers**:
- `NMK` — Network Master Key (Thread network key)
- `KEK` — Key Encryption Key
- `NKK` — Network Key Key?
- `DOK` — Device Operational Key?
- `CAK` — Certificate Authority Key?
- `LUK` — Lutron Universal Key?
- `LAK` — Link Association Key?
- `NBM` — Network Binding Material?
- `NYM` — Network ???

## .bleap File Format

- `lutron_ble_export.bleap` — export filename
- `last_ble_import.bleap` — import filename
- `SBLEAPDecryptor.sbleapDecrypt(fromURL:destURL:password:)` — decrypts .bleap files
- `isFilePasswordProtectedAtPath:` — checks if bleap is encrypted
- `isPasswordValidForArchiveAtPath:password:error:` — validates password
- `unzipFileAtPath:toDestination:...password:...` — it's a **password-protected zip**!
- `temp-bleap-unzip` — temp directory for extraction
- `DecryptionUtils.decryptUsingAESCBCData:withKey:andIV:andError:` — AES-CBC decryption

So `.bleap` = AES-CBC encrypted ZIP archive containing BLE configuration/cert data.

## Attack Surfaces for Virtual Device

### 1. OOB Without Authentication (BEST PATH)

The app explicitly says: **"The app only supports OOB without authentication"**

This means:
- No certificate validation during OOB pairing
- `performOOBWithoutAuthentication(device:completion:)` is the main code path
- `acceptInvalidCerts: true` may be set during this flow
- If we can advertise as a Sunnata on BLE and handle the GATT service properly,
  the app will send us the NMK without verifying our identity

### 2. LEAP AddressDevice with Known Serial

If we have a real device's serial number:
- `AddressDeviceCommand` takes `serialNumber:ipAddress:deviceClass:`
- Could potentially re-address a device to our virtual device's IPv6
- Need to test: does the processor validate the serial against actual device identity?

### 3. Direct NMK Injection (Already Done)

We already have the Thread network key (extracted from captures). The question is
whether the processor tracks which devices received the NMK and rejects unauthorized ones.

From our captures, the processor sends CoAP programming to devices by IPv6 address.
If we respond correctly to the programming sequence, we may be accepted.

### 4. BLE MITM During Real Pairing

- Sniff BLE advertisement of real Sunnata during pairing
- Race to connect before the Lutron app
- Relay the TLS handshake, but intercept the NMK
- This gives us: the NMK (already have it), the exact claiming data, and joiner credentials

## Connection Transport Summary

### LEAP (Processor Communication)

| Transport | Port | Protocol | Purpose |
|-----------|------|----------|---------|
| TLS Socket | 8081 | LEAP JSON | Primary control |
| MQTT+TLS | varies | LEAP JSON | Cloud relay |
| SSH | varies | LEAP JSON | LAP (legacy) |
| HTTP | varies | REST JSON | Alternate |

### BLE (Device Commissioning)

| Layer | Protocol | Purpose |
|-------|----------|---------|
| Physical | BLE 4.2+ | Radio |
| GATT | Custom services | Service discovery |
| Framing | HDLC | Byte framing over GATT |
| Security | TLS 1.2 | Encryption (loopback tunnel) |
| Application | SBLEAP | NMK delivery, claiming |

### Thread (Runtime)

| Port | Protocol | Purpose |
|------|----------|---------|
| 9190/UDP | CBOR multicast | Level control, presence, status |
| 5683/UDP | CoAP+CBOR | Programming, config |
| 19788/UDP | MLE | Mesh link establishment |

## Recommended Next Steps

1. **Sniff BLE during real Sunnata pairing** — Use nRF Connect or btlejack to capture
   the actual GATT service UUIDs, characteristic UUIDs, and data exchanged

2. **Test processor tolerance** — Our nRF is already on the Thread network with the NMK.
   Try responding to CoAP programming and emitting PRESENCE/STATUS. Does the processor
   accept an "unauthorized" device?

3. **Build BLE GATT peripheral** — nRF52840 can run both Thread and BLE simultaneously.
   Advertise the same service UUIDs as a Sunnata. Implement the TLS GATT service
   to accept NMK delivery.

4. **Try LEAP AddressDevice** — Use our LEAP client to send AddressDevice with a
   fake serial number and our nRF's IPv6. See if the processor adds it.

5. **Decode the key identifiers** — The "kek KEK... NMK" string suggests a key
   hierarchy. Understanding this tells us what keys are needed beyond just the NMK.
