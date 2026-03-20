---
name: Add tests for new modules
description: User expects comprehensive tests especially for unattended/production code like the bridge — write tests alongside new modules
type: feedback
---

When building new modules, add tests to verify stability. Especially important for code that runs unattended (RPi bridge, HA add-on).

**Why:** The bridge will run 24/7 on a Raspberry Pi with no human oversight. Regressions must be caught before deployment.

**How to apply:** Write tests for new lib/ modules using the project's test runner (`node --import tsx --test test/**/*.test.ts`). Focus on: frame parsing, decryption, EUI-64 byte order, CBOR decode, dedup logic, config loading.
