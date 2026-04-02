# CCA Event Loop Design

Reference architecture derived from Lutron firmware reverse engineering (QSM HCS08, VCRX HCS08, Alisse STM32G071) and validated against our current STM32H723 implementation.

## Lutron's Event Architecture

### Alisse (STM32G071, QS Link wired — same protocol layer as CCA)
Bare-metal superloop with 16 event types, ISR-to-mainloop via bitmask flags:

```
ISR sets bit in event_flags    (two 8-bit bitmasks at RAM)
        ↓
main:   while(1) {
          IWDG_feed();
          for each set bit → dispatch handler[bit]
        }
```

**Event priority order** (lower index = higher priority):

| # | Event | Handler | Purpose |
|---|-------|---------|---------|
| 0 | Timer tick | 0x08006661 | Decrement counters, fire timeouts — TDMA frame clock |
| 1 | Button scan | 0x08004779 | Input debounce, 10-entry circular buffer |
| 2 | RX notification | 0x080089D1 | Radio/bus has data ready |
| 3 | TX queue | 0x0800D6B9 | Process outbound packet queue |
| 4 | RX state machine | 0x08009A35 | 5-state: carrier→sync→data→validate |
| 5 | Deferred call | 0x08006531 | LED updates, async callbacks |
| 7 | Pairing mgmt | 0x09009335 | 12-slot link management |

**Key design decisions:**
1. **Timer tick is highest priority** — TDMA timing must be serviced first
2. **RX is split: notification (2) + decode (4)** — ISR is minimal, heavy work in main loop
3. **TX is queued (3), not immediate** — packets wait for their TDMA slot
4. **TX before full RX decode** — getting into slot window is time-critical

### QSM (HCS08, CC110L CCA RF)
From firmware RE (base image 0x2880-0x2960):

- TPM1 timer ISR manages TDMA slot frame
- `func_0x049B` fires on "my slot now" → initiates TX
- `func_0x049C` adjusts timer compare for next slot
- RAM 0x0143-0x0144 tracks current slot position
- RAM 0x0676 is master radio state (28 references — most accessed variable)
- 13-entry command dispatch table at 0xD020

The QSM uses a similar priority model:
1. Timer ISR (TPM1) — slot frame timing
2. SPI ISR — CC110L FIFO data ready
3. Main loop — packet decode, protocol dispatch, TX scheduling

### VCRX (HCS08, SPI radio, CCA RF)
Same pattern — event flags set by ISRs, main loop dispatches. PTAD bit 0 (GDO/interrupt) tested 219 times in the firmware — constant polling of radio status.

## Our Current Implementation (STM32H723 + FreeRTOS)

```
GDO0 EXTI ISR → vTaskNotifyGive() → cca_task wakes
                                           ↓
cca_task loop:
  1. watchdog_feed()
  2. cca_tdma_poll() → determines poll interval
  3. ulTaskNotifyTake() → sleep until GDO0 or timeout
  4. if notified: drain FIFO loop (cc1101_check_rx in tight loop)
  5. flush_rx_pending() → decode + stream + log
  6. xQueueReceive(tx_queue) → encode + transmit
  7. xQueueReceive(cmd_queue) → execute commands
```

**Already correct:**
- ISR is minimal (just sets notification flag + captures DWT timestamp)
- RX decode is deferred (pending queue flushed after FIFO drain)
- TX is queued via FreeRTOS queue
- TDMA engine exists and gates poll interval
- Batch logging (single fwrite) to avoid UART interleaving

**Gaps vs Lutron pattern:**
- Timer tick isn't a separate event — TDMA poll is inline in the main loop
- TX doesn't wait for slot window — it fires as soon as queue is drained
- No explicit RX state machine (carrier→sync→data→validate) — CC1101 handles this in hardware
- Command execution blocks the task (synchronous with delays)

## Recommended Architecture

The delta from our current code to the Lutron pattern is **small**. The main structural change is making TX slot-aware:

```
cca_task loop:
  1. watchdog_feed()
  2. tdma_tick()                          // ← service TDMA frame timer FIRST
  3. wait for GDO0 notification or timeout
  4. if RX data ready:
       drain CC1101 FIFO
       decode + enqueue to pending
  5. if TDMA says "my slot now":          // ← NEW: TX gated by slot
       dequeue TX item
       encode + transmit
       re-enter RX
  6. flush_rx_pending()                   // logging + streaming after radio work
  7. process commands (non-blocking only)
```

The key change: step 5 checks `cca_tdma_is_my_slot()` before transmitting. This is the single most important behavioral change to make us a proper CCA network citizen.

## Validation

### Same pattern across all Lutron devices
- **QSM** (CC110L, CCA RF): Timer ISR → slot gate → TX
- **VCRX** (SPI radio, CCA RF): Same event flag pattern, same priority order
- **Alisse** (STM32G071, QS Link wired): 16-event superloop, same priority order

All three use: **timer first, RX notification second, TX third, decode fourth.**

### CC1101-specific considerations
- CC1101 handles carrier detect + sync in hardware (unlike Alisse's software path)
- GDO0 interrupt replaces the Alisse's comparator+USART path
- FIFO drain timing (~2ms poll) is adequate for CCA at 19200 baud
- Our `CCA_DRAIN_SILENCE_MS=18` absorbs retransmit bursts before flushing — matches Lutron's approach of processing all pending data before responding

### What we DON'T need to change
- FreeRTOS task structure — works fine, the event-flag pattern maps cleanly to task notifications + queues
- CC1101 driver layer — already proven, register tuning applied from RE
- 8N1 decoder — strict + tolerant + CRC recovery pipeline is solid
- Pending RX queue + batch flush — already matches Lutron's deferred-output pattern

### What we DO need to change (for GLAB-28/29/30)
1. **TDMA TX gating** — check slot before transmitting (currently fires immediately)
2. **Sequence number encoding** — low bits = slot, increment by stride
3. **Retransmit scheduling** — proper retry counts and timeouts per packet type
4. **Non-blocking commands** — currently blocks task during pairing sequences
