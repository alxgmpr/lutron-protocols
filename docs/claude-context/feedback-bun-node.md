---
name: Migrate from Bun to Node.js
description: Bun lacks critical crypto ciphers (AES-128-CCM) and is unreliable — prefer Node.js with tsx for new tools
type: feedback
---

Bun is missing AES-128-CCM and other crypto ciphers needed for Thread 802.15.4 decryption. Node.js has full OpenSSL cipher support.

**Why:** Thread decryption was completely broken under Bun — no CCM ciphers at all. User expressed frustration: "bun is becoming a problem. it's a fucking hacky runtime."

**How to apply:**
- New tools that need crypto should use `#!/usr/bin/env -S npx tsx` shebang and run under Node.js
- Use `(import.meta as any).dir ?? import.meta.dirname ?? __dirname` for cross-runtime path resolution
- `tsx` is installed as a devDependency for running TypeScript under Node.js
- Existing Bun-only tools (CLI, codegen, etc.) still work — migration is incremental
- Long-term goal: migrate everything to Node.js/tsx
