# LEAP CCX Device Addressing — Discovery Notes

## Summary (2026-03-28)

Successfully addressed CCX (Thread) devices via LEAP without physical hardware.
The Lutron iOS/Android app's BLE commissioning flow was reverse-engineered from
the Android APK (jadx decompilation) to find the exact LEAP JSON payload.

## The Working AddressDevice Flow

### Prerequisites
1. CCX link must be in **Association** mode
2. Exactly **one** IPv6 address must be provided in `IPv6Properties.UniqueLocalUnicastAddresses`
3. The IPv6 address must be **reachable on Thread** — the processor's own RLOC works

### LEAP Request

```
CreateRequest /device/{deviceId}/commandprocessor
```

```json
{
  "Command": {
    "CommandType": "AddressDevice",
    "AddressDeviceParameters": {
      "SerialNumber": 90000001,
      "DeviceClassParameters": {
        "Action": "Overwrite",
        "DeviceClass": {
          "HexadecimalEncoding": "45e0101"
        }
      },
      "IPv6Properties": {
        "UniqueLocalUnicastAddresses": ["fd00::ff:fe00:3800"]
      }
    }
  }
}
```

### Post-Addressing
- Revert link to Normal mode
- Device shows `AddressedState: "Addressed"` and `SerialNumber: <value>`
- Zone `StatusAccuracy` remains "Bad" until a DEVICE_REPORT is received

## What We Tried and Why It Failed

### Wrong IPv6 format (ErrorCode 11)
- `"IPAddress": "fd00::1"` — wrong key name, processor ignores it
- No IPv6 at all — processor returns ErrorCode 11 ("Failed to activate")
- Random IPv6 addresses — processor tries to contact device, gets no response

### Missing Association mode
- Without Association mode, AddressDevice still fails with ErrorCode 11
- Both Association mode AND correct IPv6 are required

### Empty/multiple addresses (400 BadRequest)
- `"UniqueLocalUnicastAddresses": []` → "must contain only one IPv6Address but got 0"
- `"UniqueLocalUnicastAddresses": ["a","b"]` → "must contain only one IPv6Address but got 2"

### CCA-style AddressDevice (no IPv6Properties)
- Works for CCA devices (RF link) but fails for CCX (Thread) devices
- CCX requires the IPv6Properties field

### Re-addressing already-addressed devices
- Returns 204 NoContent (success) without needing Association mode or IPv6
- The "activate" step only runs on first-time addressing

## Key Findings from Android APK RE

### Source: `com.lutron.lsb` v26.1.0.4 (APK decompiled with jadx)

### LEAP Model Classes (Kotlin/KMM)

```
com.lutron.leap.common.model.AddressDevice
  @JsonClassDiscriminator("CommandType")
  └─ Address (@SerialName("AddressDevice"))
     └─ AddressDeviceParameters: AddressDeviceParametersModel

com.lutron.leap.zone.loadcontroller.AddressDeviceParametersModel
  ├─ SerialNumber: UInt (kotlin.UInt, serialized as integer)
  ├─ DeviceClassParameters: DeviceClassParametersModel (required)
  │   ├─ Action: String ("Overwrite")
  │   └─ DeviceClass: DeviceClass
  │       └─ HexadecimalEncoding: String
  └─ IPv6Properties: IPv6Properties? (optional, nullable)
      └─ UniqueLocalUnicastAddresses: List<String> (exactly 1 entry required)

com.lutron.leap.common.request.body.AssignmentCommandBody
  └─ Command: AddressDevice (field name = "Command")
```

### Assignment Flow (CcxDeviceRepo.kt + BleAssignmentStrategy.kt)

1. `enterAddressing(linkHref)` — sets link to Association mode
2. `addressDevice(deviceHref, bleDeviceInfo)` — builds AddressDeviceParametersModel:
   - SerialNumber from BLE device info
   - DeviceClassParameters("Overwrite", deviceClass from BLE metadata)
   - IPv6Properties(listOf(staticAddress from BLE assignment data))
3. Wraps in AssignmentCommandBody(AddressDevice.Address(params))
4. Sends CreateRequest to `/device/{id}/commandprocessor`
5. On error NOT_IN_ADDRESSING_MODE → retry
6. On error SERIAL_NUMBER_ALREADY_ACTIVATED → handle
7. `exitAddressing(linkHref)` — reverts link to Normal mode

### Request Metadata (Header)

The app also sends `UnverifiedMetadata` in the LEAP Header:
```json
{
  "Header": {
    "Url": "/device/{id}/commandprocessor",
    "ClientTag": "...",
    "UnverifiedMetadata": {
      "UnverifiedUserPrincipal": "updaterRef",
      "UnverifiedTimestamp": "2026-03-28T00:00:00Z"
    }
  }
}
```
This metadata is NOT required for AddressDevice to succeed (tested without it).

## Processor Behavior

- ErrorCode 11 = "Failed to activate device with serial number: N"
  - Occurs when IPv6Properties is missing or address is unreachable
  - NOT a serial number validation (any serial triggers same error)
  - NOT a cloud check (no network traffic during attempt)
  - The processor attempts to contact the device at the provided IPv6 via CoAP
  - Using the processor's own RLOC bypasses this check (it can always reach itself)

- 204 NoContent = success (device addressed)
- 400 BadRequest = malformed body (wrong types, wrong list size)

## Network Topology Reference

- RA3 Processor: 10.0.0.1 (LEAP port 8081, TLS)
- CCX Link: /link/437 (ClearConnectTypeX)
- Thread: channel 25, PAN ID 0xXXXX, mesh-local fd00::/64
- Processor RLOC: 0x3800 → fd00::ff:fe00:3800
