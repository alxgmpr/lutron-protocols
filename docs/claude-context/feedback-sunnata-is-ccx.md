---
name: Sunnata devices are CCX not CCA
description: Sunnata/Darter (HRST/RRST) devices are ALWAYS CCX (Thread). Only older devices (HQR, PJ2, RRD, LRF2) use CCA (433 MHz).
type: feedback
---

Sunnata (Darter) devices are ALWAYS CCX, never CCA. Do not include them in CCA device type tables.

**Why:** User correction — I incorrectly included Sunnata devices in a CCA device class validation table. The Designer DB confirms this: HRST/RRST devices use link type 40 (PegasusLink = CCX/Thread), while CCA devices use link types 9 (RadioRA 2) or 11 (HomeWorks Quantum).

**How to apply:** When building CCA protocol data, filter to devices with link type 9 or 11 (not 40). CCA devices include HQR (lamp dimmers), PJ2 (picos), RRD (RadioRA 2 wall devices), LRF2 (sensors), LMJ (power packs). Sunnata model prefixes (HRST, RRST, ARST) are always CCX.
