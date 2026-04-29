# CCX Device Map

Primary ML-EID addresses for all CCX keypads on the Thread network.
These are the addresses that accept CoAP programming on port 5683 (path `/cg/db/ct/c/AHA`).

Identified 2026-03-06 by sending AHA brightness commands one-by-one and visually confirming which keypad changed.

## Keypad Addresses

| Area | Station | Primary ML-EID (IID) | Full Address |
|------|---------|---------------------|--------------|
| Dining Room | Entrance | `40f8:3099:c422:8a3` | `fd0d:2ef:a82c:0:40f8:3099:c422:8a3` |
| Foyer | Entrance | `4064:afb1:788a:15b7` | `fd0d:2ef:a82c:0:4064:afb1:788a:15b7` |
| Guest Room | Entrance | `62a3:3d90:b8c7:5691` | `fd0d:2ef:a82c:0:62a3:3d90:b8c7:5691` |
| Hallway | Top of Stairs | `6b82:ccc0:105e:66ff` | `fd0d:2ef:a82c:0:6b82:ccc0:105e:66ff` |
| Hallway | End | `dac5:7b72:f699:5c9` | `fd0d:2ef:a82c:0:dac5:7b72:f699:5c9` |
| Kitchen | Entrance | `8892:e2ed:d969:cea9` | `fd0d:2ef:a82c:0:8892:e2ed:d969:cea9` |
| Laundry Room | Entryway | `4ff:7446:33a6:52e5` | `fd0d:2ef:a82c:0:4ff:7446:33a6:52e5` |
| Living Room | Entry | `ae7a:5e71:f38f:91d0` | `fd0d:2ef:a82c:0:ae7a:5e71:f38f:91d0` |
| Living Room | Fireplace | `b360:7c9d:6182:4bdb` | `fd0d:2ef:a82c:0:b360:7c9d:6182:4bdb` |
| Master Bedroom | Bedside | `e04a:7614:6f0f:6abd` | `fd0d:2ef:a82c:0:e04a:7614:6f0f:6abd` |
| Master Bedroom | Entrance | `30ca:5c50:fa22:101b` | `fd0d:2ef:a82c:0:30ca:5c50:fa22:101b` |
| Office | Entrance | `b7cf:f63c:a031:a637` | `fd0d:2ef:a82c:0:b7cf:f63c:a031:a637` |
| Stairs | Base | `e1b0:81a0:2078:c53b` | `fd0d:2ef:a82c:0:e1b0:81a0:2078:c53b` |

## Notes

- These are **primary ML-EIDs** (random IIDs), not the secondary ML-EIDs (EUI-64 derived, `ff:fe` pattern) stored in the Designer database.
- Secondary ML-EIDs (from Designer DB `tblPegasusLinkNode.IPv6Address`) cannot be reached from our nRF dongle — Thread address resolution doesn't know about them. Only the processor can route to those.
- The Designer DB also has devices not in this list (dimmers, multi-gang secondary devices) that don't have AHA buckets.
- Not all keypads from the Designer DB are represented — Master Bedroom Closet, Office Closet, Dining Room Back Doorway, and Foyer Entrance (device 2) were not among the 13 AHA-accepting addresses. They may be secondary gangs or SunnataKeypads without status LEDs.

## AHA Brightness Control

```bash
# Set keypad LED brightness (k4=active level, k5=inactive level, 0-255)
NUCLEO_HOST= bun run tools/ccx/ccx-coap-send.ts aha --dst <full-address> --k4 <level> --k5 <level>

# Example: set office keypad very dim
NUCLEO_HOST= bun run tools/ccx/ccx-coap-send.ts aha \
  --dst fd0d:2ef:a82c:0:b7cf:f63c:a031:a637 --k4 10 --k5 10
```
