---
name: No LEAP subscriptions or polling in bridge
description: NEVER suggest using LEAP subscriptions or zone status polling as a solution for the CCX-WiZ bridge
type: feedback
---

NEVER suggest LEAP subscriptions, zone status polling, or any LEAP-based real-time monitoring as a solution for the bridge or any similar problem. The bridge decodes Thread traffic directly — that's the whole point.

**Why:** The user was extremely clear this is unacceptable. The bridge is a passive Thread sniffer, not a LEAP client. Scene data should be decoded from existing sources (Designer DB, LEAP dump data, or static config).

**How to apply:** When the bridge needs data it can't get from Thread multicast, look to the Designer DB or pre-fetched LEAP dump data for static lookups. Never suggest runtime LEAP connections from the bridge.
