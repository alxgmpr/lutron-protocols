---
name: 802.15.4 EUI-64 byte order in CCM* nonce
description: IEEE 802.15.4 stores extended addresses in LE byte order in frames, but CCM* nonces require BE (canonical) order — must reverse before decryption
type: feedback
---

IEEE 802.15.4 extended addresses (EUI-64) are stored LITTLE-ENDIAN in frames, but the CCM* nonce requires them in BIG-ENDIAN (canonical EUI-64) order. `parseFrame()` returns raw LE bytes from the frame — these MUST be reversed before passing to `buildNonce()` / `decryptMacFrame()`.

**Why:** Wireshark/tshark hides this by reversing internally — `wpan.src64` is already in canonical BE form. When we process raw frames from the serial sniffer (bypassing tshark), we get LE bytes and must handle the conversion ourselves.

**How to apply:** Any code that takes an extended address from a parsed 802.15.4 frame and uses it for CCM* decryption must reverse the 8 bytes first. The LEAP-derived EUI-64s (from `getAllDevices()`) are already in BE/canonical order and don't need reversal.
