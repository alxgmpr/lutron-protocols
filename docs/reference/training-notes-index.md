# Lutron FSE Training Notes — Index

Index of the [xmocxd/lutron-training-notes](https://github.com/xmocxd/lutron-training-notes) corpus — ~10K lines of raw training notes from what appears to be a Lutron Field Service Engineer's onboarding (Phase 1 remote, Phase 2 in-person, OJT). Insider knowledge of commissioning workflows, system limits, and internal tooling — much of it not in public documentation.

## Source layout

| Path | Content |
|------|---------|
| `combined-searchable/raw.txt` | 6018-line flat concat of all notes — use this for grep |
| `md-drafts/md-raw-revise.md` | 3771-line reorganized draft (overlaps raw.txt) |
| `added-to-md/*.txt` | Per-day session notes (Phase 1 remote d1-4, in-person d1-4, training 1-5, onboarding d1-2, OJT 1) |
| `new/phase 2 - {1..4}.txt` | Phase 2 training day notes (in-person) |
| `new/qual-card.txt` | FSE qualification checklist — every skill a new FSE must demo |
| `new/numbers.txt` | Hard system limits (devices, wire length, range) |
| Root `.md` files | Mostly empty category stubs |

## RE-relevant findings

### Firmware extraction

- **Firmware files ship inside Designer's install dir**: `C:\Users\[User]\AppData\Local\Packages\LutronElectronics.LutronDesignerGamma_[ver]\LocalCache\Local\Lutron Designer [ver]\Firmware\qs_firmware_and_tools\[Device Model]\[Gen#]\v*.s19` ([raw.txt:3935](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L3935)). Designer bundles all QS device firmware — a deploy-able Designer install is a firmware dump. **Grafik Eye is included** (directory `qs_firmware_and_tools/QSG/QSGR (512kB - new hardware)/`) despite the notes saying otherwise — see [firmware-re/grafik-eye.md](../firmware-re/grafik-eye.md).
- **`.s19` = firmware** confirmed as the file extension ([raw.txt:2476](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L2476)) — Motorola S-record, matches our HCS08 assumption in [firmware-re/qsm.md](../firmware-re/qsm.md).
- **Two firmware tiers exist internally**: "job specific" firmware (per-job patches) and "internal release" firmware, neither to be used in normal startups ([raw.txt:2483-4](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L2483)). Implies Lutron has a fleet of non-public binaries.
- **Boot firmware vs OS firmware**: Boot code is never updated in the field; OS firmware is flashed via the QSE-NWK/Flash tool with boot code bootstrapping it ([raw.txt:4381](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L4381)). A given boot revision caps the max OS version — worth checking against any stuck/bricked units.
- **Lutron's stated reason for not sharing Grafik Eye firmware files**: "we don't want people to be able to decompile the raw firmware" ([raw.txt:2225](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L2225)). Explicit acknowledgement that RE is the concern — relevant to [firmware-re/qsm.md](../firmware-re/qsm.md) and [security/firmware-cdn.md](../security/firmware-cdn.md).
- **Firmware auto-pull**: Athena procs phone home at midnight daily for approved firmware ([raw.txt:3612](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L3612)); CCX device firmware flashes automatically at 3 AM ([raw.txt:3977](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L3977)); QS device firmware is NOT auto-updated ([raw.txt:3897](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L3897)). Good to know for timing when sniffing firmware-CDN traffic.

### Radio / protocol behavior

- **Athena Wireless Processor is RX-only on CCA**: "It ONLY LISTENS CCA — does not talk CCA" ([raw.txt:2529](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L2529)). Confirms our CCA task design in [reference/cca-event-loop.md](cca-event-loop.md) — any CCA-TX observed would be non-Athena.
- **Grafik Eye is the *only* device that both talks and listens on CCA** ([raw.txt:2112](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L2112)). All other CCA devices (picos, sensors) are TX-only. Good calibration target for bidirectional capture.
- **"CCX interface" product exists**: physically identical to Athena wireless processor but no CCA radio ([raw.txt:2531](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L2531)). Worth hunting on eBay if we want a pure-CCX reference.
- **CCA device cap: 50 max, mixed** — 50 picos OR 5 daylight + 15 occ/vac + some picos ([new/numbers.txt:70](https://github.com/xmocxd/lutron-training-notes/blob/main/new/numbers.txt#L70)). Useful TDMA slot-count sanity check for our CCA decoder.
- **CCX mesh constraint**: each device within 25 ft of ≥2 others; gateway within 75 ft of furthest device ([raw.txt:107](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L107)). Explains Thread parent selection heuristics we've observed.
- **Ketra emergency behavior**: bulbs monitor CCX heartbeat — 5 sec of silence triggers emergency level ([raw.txt:1633](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L1633)). Implication: the CCX gateway emits some recurring beacon that bulbs track as "liveness." Worth sniffing for in our [ccx-wiz-bridge](../../bridge/).

### Backdoors, terminals, and consoles

- **LEAP Console** — Connect Portal has a "System Monitor" with a LEAP console for sending commands to the processor ([raw.txt:1762](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L1762)). Confirms cloud-side LEAP proxying ([infrastructure/cloud-proxy.md](../infrastructure/cloud-proxy.md)) exposes the full API for diagnostics.
- **"Software Security — Terminal"** is listed as a required FSE skill on the qual card ([new/qual-card.txt:55](https://github.com/xmocxd/lutron-training-notes/blob/main/new/qual-card.txt#L55)) — FSEs are trained to use a terminal interface for security-sensitive operations. Worth investigating what "Terminal" refers to (possibly the IPL telnet on :23/:8902, or a Designer UI).
- **Hidden menus appear contextually**: "a lot of these menus are hidden from the main screen when it knows it is part of an athena [system]" — likely referring to Grafik Eye ([raw.txt:2211](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L2211)). Standalone mode vs networked mode exposes different feature sets — relevant to [designer-feature-flags](../../.claude/skills/designer-feature-flags/).
- **NWK has 2 concurrent telnet connection cap** ([raw.txt:1582](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L1582)). Useful to know when planning multi-client IPL work.
- **AV integration uses telnet for older systems, API for newer** ([raw.txt:5958](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L5958)) — matches our IPL vs LEAP split in [protocols/ipl.md](../protocols/ipl.md).

### Defaults and credentials

- **Default Athena WiFi PSK: `DigiDog`** — "make sure you change! DO NOT document in trip report" ([raw.txt:3588](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L3588)). Factory-reset units are on this PSK. Explicit warning about not leaking it in reports is ironic given it's now in public training notes.
- **Admin password is stored in Salesforce** after CCX pairing ([raw.txt:3728](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L3728)) — per-job passwords live in Lutron's Salesforce, not in the device.
- **Admin PIN reset on seeTouch-style keypad**: "turn unit right to take off wall, recessed reset button on back, press and hold 20 sec" ([raw.txt:2978](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L2978)). Hardware reset path worth documenting in [hardware/overview.md](../hardware/overview.md).

### System architecture corroboration

- **16 processors max per system (including CCX gateways)** ([new/numbers.txt:9](https://github.com/xmocxd/lutron-training-notes/blob/main/new/numbers.txt#L9))
- **2000 ft QS Link wire length** (12 AWG) / 500 ft (18 AWG) ([new/numbers.txt](https://github.com/xmocxd/lutron-training-notes/blob/main/new/numbers.txt))
- **Area limits**: 16 scenes + off, 31 shade presets, 100 zones, 99 switch legs per zone ([new/numbers.txt:99](https://github.com/xmocxd/lutron-training-notes/blob/main/new/numbers.txt))
- **Sense line = wire #5 in Lutron panel link** carries emergency signal ([raw.txt:424](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L424)) — physical-layer detail for panel-link sniffing.
- **GRX/Legacy protocol has an extra orange wire** ([raw.txt:2959](https://github.com/xmocxd/lutron-training-notes/blob/main/combined-searchable/raw.txt#L2959)) — for anyone doing legacy OMX work.
- **DMX cap: 32 channels output per interface, max 16 DMX interfaces per QS Link** ([new/numbers.txt:51](https://github.com/xmocxd/lutron-training-notes/blob/main/new/numbers.txt#L51))

## Topic map (where to grep in raw.txt)

| Topic | Rough line range | Notes |
|-------|------------------|-------|
| System capacity limits | 1–140 | Per-product caps (processors, picos, sensors, zones) |
| Tunable white / CCT methods | 140–220 | 2-control vs warm/cool, kelvin ranges |
| LED drivers & model prefixes | 220–260 | L3D, LTE-prefix → compatible dimmer class |
| Advanced emergency lighting | 260–500 | UL 924, LUT-ELI, NFPA, panel wiring, sense line |
| Quantum architecture | 500–650 | QP2/QP3 hubs, 2-link procs, inter-processor link |
| Keypads (seeTouch, Palladiom) | 650–820 | 11-button internal layout, CCI mapping, LED feedback |
| Picos & wallstations | 820–980 | Pairing, PDU vs non-PDU, QSM pairing |
| DMX / DIN rail / CCO-CCI / Grafik Eye | 980–1450 | Dip switches, shunt relays, QSG firmware |
| CCX/CCA radio overview | 1450–1850 | Athena wireless proc vs CCX gateway, dual radio |
| Processor LEDs & boot states | 1850–2000 | Color/blink = state mapping |
| LEAP / BACnet / NTP | 1980–2720 | API, RabbitMQ, SSH/SCP file transfer |
| Networking (multicast, DHCP, switches) | 2680–3600 | PIM, IGMP, managed switches, WiFi setup |
| Firmware updates (QS / CCX / proc) | 3600–4450 | File paths on disk, flash tool, boot vs OS firmware |
| Designer workflows / startup | 2250–2450, 4500+ | FSL check-in, SOO review, device activation |
| Qual card / FSE training checklist | qual-card.txt | Every skill required for FSE signoff |

## How to use this

When working on an area and wanting insider context:

```bash
grep -n -i "keyword" data/lutron-training-notes/combined-searchable/raw.txt
```

Repo is cloned at `data/lutron-training-notes/` (gitignored via `data/*`). Lives persistently in the main repo's `data/` dir — worktrees access it via a symlink.

High-signal keywords to try: `hidden`, `note`, `warning`, `do not`, `NEVER`, `password`, `default`, `boot mode`, `firmware files`, `telnet`, `leap console`, `terminal`, `support wiki`, `dip switch`.

## Open questions worth chasing

1. **What is "Software Security — Terminal"?** — the qual card mentions it as a required skill distinct from "Activate CCX devices." Possibly means the IPL :23 telnet, Designer's terminal UI, or a different surface.
2. **"Job specific" and "internal release" firmware** — how are these published? Same S3 CDN under different paths, or internal-only distribution?
3. **LEAP Console in Connect Portal** — what commands does Lutron's FSE-facing console surface? If it mirrors the full LEAP API, it's a diagnostic superset worth cross-referencing against [protocols/leap.md](../protocols/leap.md).
4. **Grafik Eye bidirectional CCA** — capture a Grafik Eye TX and verify packet format differs from pico TX in our [protocols/cca.md](../protocols/cca.md).
5. **Ketra 5-second CCX heartbeat** — identify the beacon packet in CCX sniffer output; it's probably a periodic multicast we've been ignoring as noise.
