---
name: CCX stream source address gap
description: Nucleo CCX stream drops source IPv6/RLOC16 — firmware has it but doesn't send it to CLI
type: project
---

The Nucleo's CCX stream framing (`StreamTxItem`) discards source IPv6 address before sending to TCP clients. Current frame: `[FLAGS:1][LEN:1][TS_MS:4][CBOR:N]` — no sender info.

The firmware already extracts full source IPv6 (16 bytes) and RLOC16 (2 bytes) in `ccx_process_rx()` (ccx_task.cpp ~line 1252), uses them for peer table updates and UART logging, but `stream_send_ccx_packet()` only passes the CBOR payload.

**Why:** This is why the sniffer (tshark) shows device names per packet but the Nucleo CLI doesn't — the CLI never receives who sent each message.

**How to apply:** Extend stream framing to include source RLOC16 (2 bytes, minimal) or full IPv6 (16 bytes). Requires:
1. Extend `StreamTxItem` struct in `stream.cpp` to carry source address
2. Update stream framing format (new version byte or extended FLAGS)
3. Update CLI `nucleo.ts` stream parser to extract and display source
4. Use `getDeviceName()` or peer table lookup for sender name resolution

Most CCX traffic is multicast (LEVEL_CONTROL, BUTTON_PRESS, DIM, SCENE_RECALL, DEVICE_REPORT) so the Nucleo sees it all — it just can't show WHO sent it.
