# Lutron Tools Project Memory

## User Preferences
- **NEVER use `st-flash`** — always use `make flash` (openocd) for STM32 programming
- **`esphome run` ALWAYS needs `--no-logs`** — streams logs forever otherwise
- **Dev UI is at http://localhost:5173** — don't use curl for things the web UI can do
- **ldproxy must be started manually** — `node server.js` in `ldproxy/`, run attached so logs are visible
- **Migrate from Bun to Node.js** — Bun lacks AES-128-CCM and other ciphers; use `npx tsx` for new tools — see `memory/feedback-bun-node.md`
- **NEVER suggest LEAP subscriptions/polling for bridge** — bridge decodes Thread traffic, period — see `memory/feedback-no-leap-subscribe.md`
- **Sunnata/Darter devices are ALWAYS CCX, never CCA** — only older devices (HQR, PJ2, RRD, LRF2) use CCA — see `memory/feedback-sunnata-is-ccx.md`
- **ONE UDP client to Nucleo at a time** — multiple connections cause packet loss; never run capture + CLI simultaneously — see `memory/feedback-single-udp-client.md`

## CCA Protocol — See `docs/cca-protocol-notes.md`
- Vive pairing, bridge pairing, dimming, set-level, fade, config (LED/fade/trim/scene/phase)
- Pico 4-button structure, dimmer ACK packets, RTL-SDR verification techniques
- Key: type 0x80-0x9F = 24 bytes, 0xA0+ = 53 bytes; CC padding with 0xCC not 0x00
- Level encoding: `level16 = percent * 0xFEFF / 100`
- Fade encoding: `byte = seconds * 4` (quarter-seconds)
- **Daylight sensor (LRF-DCRB) decoded** — SENSOR_LEVEL (fmt 0x0B, 16-bit lux 0-0x07FE=0-1600), SENSOR_TEST (fmt 0x09)
  - Component type 0xD5 = daylight sensor, device type 0x0D = IREYE (QS Link sensor class)
  - OWT cycles type bytes sequentially (8A→8B→88→89), 12 packets/burst when paired
  - **Sensors are bidirectional during CCA transfer** — C1/C5 handshake (type+4, not type+1 like dimmers)
  - PAIR_BA format 0x17 = sensor announcement before transfer
  - **CCA "pairing" is really full system transfer** — broadcasts ENTIRE device table to ALL devices
  - Config via A5/A6/A7/0x85: packed serial list `[4B serial][0x80]`, split by packet capacity not device type
  - Burst count / channel programmed during transfer (unpaired=few, paired=12+)

## CCX Bridge — See `memory/ccx-serial-bridge.md`, `memory/ha-addon-deployment.md`
- **Deployed as HA local add-on** at 10.0.0.4 (Pi5) — full config in HA UI, no separate config file
- **Serial sniffer** with 30s watchdog — auto-reconnects on dongle crash/USB suspend
- **USB autosuspend disabled** in `run.sh` — Pi5 kills dongle otherwise
- **Config**: `bridge/ha-addon/config.yaml` options/schema = pairings + Thread creds + warm dim + scaling
- **YAML config fallback** (`config/ccx-bridge.yaml`) for standalone Docker/local dev
- **Deploy**: `./bridge/deploy-ha.sh /Volumes/config /Volumes/addons` (SMB to HA)
- **EUI-64 byte order**: 802.15.4 frames store LE, CCM* nonce needs BE — MUST reverse — see `memory/ccx-eui64-byteorder.md`
- nRF sniffer protocol: `sleep` → `echo off` → `channel` → `receive` — see `memory/nrf-sniffer-serial-protocol.md`
- Modules: `lib/serial-sniffer.ts`, `lib/frame-pipeline.ts`, `lib/bridge-core.ts`, `bridge/main.ts`
- Short-addr unicast (processor↔device) can't be decrypted — CCX commands are multicast with extended source

## CCX Protocol — See `docs/ccx-protocol-notes.md`, `memory/ccx-protocol.md`
- Thread network injection works — no pairing needed, just network credentials
- CoAP programming: send to device PRIMARY ML-EID, path `/cg/db/ct/c/AHA`
- Secondary ML-EIDs (EUI-64, in Designer DB) NOT reachable from nRF dongle
- AHA LED brightness: `[108, {4: <active>, 5: <inactive>}]` (0-255)
- 13 keypads mapped — see `docs/ccx-device-map.md`
- NCP TX requires computing UDP checksum manually
- CCX multicast works — router promotion at boot is required (don't remove it)
- NCP needs ~40s after boot to fully join Thread mesh (probe + join + promote)
- TMF Address Query (`/a/aq`) doesn't work from NCP mode — NCP handles TMF internally
- Thread decryption: shared modules in `lib/thread-crypto.ts` + `lib/ieee802154.ts` — see `memory/ccx-thread-decryption.md`
- Skills: `/nrf-ot` (RCP mode), `/nrf-sniffer` (capture mode)
- RA3 programs devices via secondary ML-EIDs, not primary ML-EIDs
- **Scenes are pre-programmed into devices during transfer** — BUTTON_PRESS is just a multicast trigger, no per-zone LEVEL_CONTROL follows — see `memory/ccx-scenes.md`
- LEVEL_CONTROL IS multicast (not unicast) — that's how the bridge works
- **Preset programming decoded** — `/cg/db/pr/c/AAI` type 72 = preset→level, `/cg/db/mc/c/AAI` = device→zone mapping — see `memory/ccx-preset-programming.md`
- Decode tool: `tools/decode-preset-assignments.ts`, lookup table: `data/preset-zones.json`
- **Nucleo stream drops source IPv6** — firmware has it but `stream_send_ccx_packet()` only sends CBOR — see `memory/project-ccx-stream-source-addr.md`

## NCP Dongle — CRITICAL (See `/hardware` skill)
- **4 wires**: VCC, GND, TX (P0.20), RX (P0.24) — soldered to Nucleo USART2
- **Pre-built DFU**: `firmware/ncp/ot-ncp-ftd-dfu.zip` — ALWAYS use this to recover
- **Source**: `~/lutron-tools/src/ot-nrf528xx/` — build with `-DOT_BOOTLOADER=USB` (NOT UART)
- **NEVER rebuild NCP without checking `firmware/PROJECT.md`** for exact build commands
- **`ot reset` removed from shell** — it bricked the NCP into DFU bootloader
- **EUI-64**: `F4:CE:36:70:D6:82:E5:33`

## LEAP Infrastructure — See `docs/infrastructure-notes.md`, `memory/leap-probing.md`
- RA3 (10.0.0.1), Caseta (10.0.0.2), LEAP API is read-write
- Cloud proxy: `api.iot.lutron.io/api/v2/leap/{bridge-id}`
- LEAP constructor: `new LeapConnection({ host, certName })` (object, not positional args)

## IPL Protocol (Designer) — See `docs/infrastructure-notes.md`, `memory/ipl-protocol.md`
- TLS:8902, binary framing with zlib JSON

## Daylighting System — See `memory/daylighting-system.md`
- Two systems: **Hyperion** (shade/facade, supported) vs **light-level** (dimmer control, scaffolded but NOT activated)
- LRF2-DCRB paired in Office, serial 13100184 — sends SENSOR_LEVEL packets, processor ignores them
- Designer auto-creates daylightable (ZoneID+1), DaylightingGroup (AreaID+1), setpoints (400 lux @ 100%) for every zone/area
- Missing: `tblDaylightingRegion` (sensor→area binding), `tblGainGroup` (per-zone calibration), `DaylightingType` still 0
- RA3 LEAP: `/photosensor`, `/sensor`, `/daylightinggainsettings` all "not supported" — Caseta DOES expose gain settings
- ESN telnet: `AREAENTEREXITDAYLIGHTING`, `FASTDAYLIGHTING` commands exist but untested
- Open question: firmware gated behind commercial license, or just needs DB population + transfer?

## GLAB-9: Cross-Pairing Caseta→RA3 — See `memory/project-glab9-dvrf-fingerprint-patch.md`
- DVRF-6L announce packet has QSDeviceClassTypeID `0x04630201` at bytes 20-23
- Patched SQLMODELINFO: added LSTQSDEVICECLASSTYPE entry + changed RRD-6CL device info
- Resets on Designer restart (SQLMODELINFO rebuilds from MSIX)

## Designer DB & Project Injection — See `docs/infrastructure-notes.md`
- `memory/designer-model-validation.md`, `memory/designer-file-format.md`, `memory/hw-project-injection.md`
- Live DB + save trick works for both CCX and CCA devices
- SerialNumberState=2 is CRITICAL for transfer

## ESN-QS Firmware — See `memory/esn-firmware-analysis.md`
- M68K architecture, "QS Link" = CCA radio

## Firmware Updates — See `docs/firmware-cdn-re.md`, `memory/firmware-update-infra.md`
- **Phoenix/lite-heron firmware DECRYPTED** — AES-128-CBC, key `6cba80b2bf3cf2a63be017340f1801d8` from eMMC
- Vive uses RSA-4096 `pkeyutl -verifyrecover` (512-byte key.enc, primary.pub)
- Phoenix/lite-heron use AES-128-CBC symmetric (65-byte base64 key.enc + iv.hex)
- **OTA protocol decoded** — custom CoAP `/fw/` paths, NOT MCUboot SMP — see `memory/ccx-firmware-ota-protocol.md`
- Firmware is **re-encrypted for OTA** (entropy 7.99 bits/byte) — no plaintext capture possible
- CoAP Block1 (RFC 7959), 128-byte blocks, unicast to target device
- Extractor: `tools/extract-fw-blocks.ts`, capture: `/tmp/ccx-fw-capture/`
- **Designer never decrypts** — pushes encrypted package to processor via FTP; processor decrypts
- **RA3 ROOT SSH**: `ssh -i ~/.ssh/id_ed25519_lutron root@10.0.0.1` (injected 2026-04-01 via eval vuln)
- SSH port 22 pubkey only, `support` user has Lutron employee key `abhat@PC0008690`

## Phoenix Rootfs Analysis — See `docs/phoenix-rootfs-analysis.md`
- **Rootfs decrypted and extracted** at `data/firmware/phoenix/v26.01.13f000/`
- Radio: Silicon Labs EFR32 coprocessor(s) via UART/HDLC/CLAP at 230400 baud — NOT CC-series
- Thread stack is fully proprietary (NOT OpenThread) — "Pegasus" internally
- Janus variant = dual-radio (CCX + CCA coprocessors) — how RA3 bridges legacy devices
- LEAP API: 384 endpoints, 773 object types — full inventory in the doc
- Firmware decryption keys stored plaintext in `/etc/lutron.d/secure_element_external_keys/`
- ATECC608 secure element (I2C 0xC0): 16 slots for ECC keys, AES keys, secrets
- Device codenames: dart=Diva Smart, thin-mint=Sunnata, powerbird=Sunnata toggle, hercules=sensor, lorikeet/omnikeet=repeaters

## Sunnata Hardware — See `memory/sunnata-hardware.md`
- **EFR32MG12P432** (Silicon Labs Cortex-M4), NOT nRF52840
- External flash: Winbond W25Q32JV (4MB SPI NOR)
- SWD debug: 0.05" pitch 2x5 header soldered on a keypad; needs J-Link (not ST-Link)
- Debug lock almost certainly enabled; MG12 has no Secure Element (plaintext if bypassed)
- BLE used for commissioning — sniff with nRF52840 dongle + nRF Sniffer for BLE

## Wiz Bulb — See `memory/wiz-bulb.md`, `memory/wiz-rgbwc-dimming.md`
- 10.0.0.50, MAC a0b1c2d3e4f7, ESP24_SHRGB_01 fw 1.36.1
- Bridged to Lutron CCX zone 5147 (Hallway Table Lamp)
- UDP:38899 JSON protocol; setPilot=instant, setUserConfig(fade)=MQTT only
- Config: `data/virtual-device.json`, test: `tools/wiz-test.ts`
- Ramp rate: 21.053%/sec (4.75s full range, 19 quarter-seconds) — wall-clock model, matches Lutron within 1%
- **RGBWC sub-10% dimming**: raw channel values 2-255 bypass `dimming` 10% floor; value 1 turns off (rounding)
- **All bulbs identical hardware**: BP5758D driver, same 14-point CCT table, curr [28,28,28,48,48]
- **WiZ project**: `/Volumes/Secondary/wiz` — firmware RE, UDP CLI, MQTT intercept, protocol docs

## Phoenix Processor UART Boot — See `docs/claude-context/phoenix-uart-boot.md`
- AM335x UART boot via SYSBOOT2 pin grounding — XMODEM loads custom SPL
- Custom U-Boot SPL (am335x_evm config, modified for Phoenix 26MHz/BBB DDR3)
- ARM entry stub does WDT, clocks, DPLL (PRCM writes crash from C/Thumb but work from ARM)
- DDR init is last blocker — EMIF needs L3 CLKSTCTRL from ARM stub
- Tools: `tools/phoenix-uart-boot.py` (XMODEM), `tools/phoenix-emmc-dump.py` (sector dump)
- Build: `/tmp/u-boot-2017.01/` (source), `/tmp/phoenix-boot/` (artifacts)

## Network Topology
- Designer VM: `ssh alex@192.168.64.4` (key auth, UTM Shared Network/NAT)
  - Mac from VM: `192.168.64.1` (stable gateway IP)
  - ldproxy: VM Charles maps to `192.168.64.1:3000`
- RA3: 10.0.0.1, Caseta: 10.0.0.2, Nucleo: 10.0.0.3 (TCP:9433), HA: 10.0.0.4 (SMB, SSH)
- RA3 LEAP links: CCX=`/link/437`, CCA=`/link/439` (changed from 234/236 after RA3 reset)

## Designer Account System — See `ldproxy/README.md`
- Channels = `[Flags] enum ChannelTypes` in `Lutron.Gulliver.Infrastructure.dll`
- Channel strings from API mapped via `[Display(Name)]` → bitfield
- `ProductType` set at app startup; channels filtered by `SetUserChannelsForProduct()`
- Feature flags = separate system (Rollout.io/CloudBees), keyed by `FeatureFlagType` enum
- Decompile with: `DOTNET_ROOT=/opt/homebrew/Cellar/dotnet/10.0.103/libexec DOTNET_ROLL_FORWARD=LatestMajor ilspycmd`

## Designer Unlock — RA3 in HW Toolbox (WORKING)
- **Both MDFs usually reset on Designer restart** — re-apply each time (but survived a crash once)
- Skill: `/designer-unlock` applies all 4 gates; `/ra3-hw-fix` is deprecated
- **Gate 3b was the missing piece**: `TBLMODELINFOTOOLBOXPLATFORMTYPEMAP` overrides family-level values
  - `ProductInfoHelper.GetLocationBasedToolboxPlatformTypesForModel()` checks model table FIRST
- Gates 1/3a/3b are universal (no model filter). Gate 2 must be scoped.
- **Gate 2 MUST NOT add raw TBLMODELINFO entries** — only models from other ProductMasterLists
  - Adding models with no UI resources crashes: `InvalidStringIdException: stringId 18453 not valid in visual 9`
  - Safe scope: models that exist in at least one other ProductMasterList (cat != 18)
- `4128 = 0x1020 = HomeworksQS(0x20) + myRoomLegacy(0x1000)`
- Sunnata prefixes: HRST=HW(stock), ARST=Athena/QS, RRST=RA3 — RRST/ARST share families
- See `docs/ra3-to-hw-migration.md` for full details
