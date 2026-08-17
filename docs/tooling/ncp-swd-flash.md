# Reflashing the NCP over SWD

Programming the nRF52840 NCP from the Nucleo, with no USB cable and no
`nrfutil`. The STM32 bit-bangs SWD to the dongle's two round pads and writes
flash directly.

Before this existed, replacing NCP firmware meant unplugging the dongle,
plugging its USB into a Mac, and running `nrfutil` — which is awkward, because
SB2 is cut and the dongle is powered from the Nucleo's 3V3, so its own USB
does not power it.

## Quick start

```bash
npx tsx tools/swd/ncp-flash.ts --hex firmware/ncp/ot-ncp-ftd.hex
```

That is the whole procedure. The tool opens a session, streams the image over
in windows, verifies each page, resets the part, and waits for it to rejoin
Thread.

You need an Intel HEX. `firmware/ncp/ot-ncp-ftd-dfu.zip` is a DFU package and
will not work. From an `.elf`:

```bash
arm-none-eabi-objcopy -O ihex build/bin/ot-ncp-ftd ot-ncp-ftd.hex
```

## Why it is windowed

`ot-ncp-ftd.hex` is 633 KB of text — 225 KB of image once decoded. The STM32
has roughly 76 KB of RAM free. The image cannot be buffered, so it is streamed:

1. The host uploads a ~60 KB window through the existing OTA upload commands
   (`STREAM_CMD_OTA_UPLOAD_START/CHUNK/END`, the same path
   `tools/cca/ota-upload.ts` uses).
2. `swd flash window <crc32>` checks the CRC, then feeds the window through the
   firmware's Intel HEX parser. Bytes land in a 4 KB page buffer; each page is
   erased, programmed and verified as the stream moves past it.
3. Repeat. Nothing larger than one target page is ever held.

The CRC is checked **before** any of the window is parsed. The upload is
unacknowledged UDP, so a dropped chunk is routine — and a window that has
already been half-programmed cannot be re-sent, because the pages behind it are
erased and written. Checking first is what makes the retry safe.

## The memory map it works within

Read back off the bench dongle over SWD:

| Address | Value | What it is |
|---|---|---|
| `0x00000000` | SP `0x20000400`, PC `0x00000999` | MBR |
| `0x00001000` | SP `0x20040000`, PC `0x00031591` | application vector table |
| `0x10001014` | `0x000E0000` | UICR NRFFW[0] — bootloader start |
| `0x10001018` | `0x000FE000` | UICR NRFFW[1] — bootloader settings |

The app starts at `0x1000`, not `0x0`, because the NCP is built with
`-DOT_BOOTLOADER=USB`. `ot-ncp-ftd.hex` spans `0x1000..0x37FB8`.

`swd flash begin` reads NRFFW[0] and uses it as the region ceiling, falling
back to `0xE0000` if the word is erased or implausible. Any HEX record
addressed outside `[0x1000, ceiling)` is refused **before** anything is erased.
That guard is the entire safety story:

- Below `0x1000` is the MBR. `ot-ncp-ftd.hex` starts at `0x1000`, so it cannot
  put an erased MBR back.
- At `0xE0000` and above is the factory USB bootloader — the DFU recovery path.

## Never ERASEALL

CTRL-AP ERASEALL erases the MBR and the bootloader along with the app. After
that, `nrfutil` DFU recovery no longer exists on that dongle and SWD is the
only way to program it, permanently.

`swd flash` never issues it. It is a separate command with a separate name and
an explicit confirmation:

```
swd recover           # prints what it destroys, does nothing
swd recover confirm   # actually does it
```

Only worth it for a part that is already unreachable.

## Shell commands

| Command | Effect |
|---|---|
| `swd flash begin [start [end]]` | Open a session. Hex bounds; defaults to `0x1000`..UICR NRFFW[0] |
| `swd flash window <crc32>` | Verify and program the window just uploaded |
| `swd flash end` | Flush, require the EOF record, reset the part, trigger the Thread rejoin |
| `swd flash abort` | Give up; releases the pins and the interlock |
| `swd flash status` | Region, windows, image bytes, pages written |

`swd flash begin` also handles a dongle sitting in its USB bootloader. APPROTECT
is engaged in hardware at every reset and the 2018-era bootloader never clears
it, so AP0 is blocked; OpenThread's startup does clear it. `begin` pin-resets
over CTRL-AP and then polls for up to 10 s. A single early re-probe reports a
reset that worked as a failure — this is why it polls rather than sleeping once.

A pin reset does **not** clear GPREGRET. A dongle put into DFU by the `0xB1`
magic re-enters DFU on every reset; only a power cycle clears that, and SB2 is
cut, so the power cycle has to come from the Nucleo's 3V3.

## Thread credentials come back automatically

A reflash wipes the NCP's Thread dataset, and the STM32 only ever pushed
credentials from its boot-time `thread_join()`.

This is the failure worth knowing about, because nothing looks broken. A
freshly reflashed NCP answers Spinel, `ot channel` and `ot panid` read back
plausible values, and the role sits at `DETACHED` with nothing received. From
the outside it is indistinguishable from a dead radio.

`ccx_task` now re-probes and re-pushes by itself after a reflash, over several
rounds — the first is expected to fail while the new image is still booting. No
STM32 reboot needed. `ncp-flash.ts` waits for the role to leave `DETACHED`
before it reports success; pass `--no-wait-thread` to skip that.

## Interlocks

While a flash is open:

- `ccx_task` stands down. Its liveness watchdog treats an NCP that stopped
  answering Spinel as one to reset — exactly what a part being programmed looks
  like — and it drives the same two pins to do it. On release, the liveness
  clock restarts from the end of the flash, so a healthy part is not
  immediately "recovered".
- `swd_lock` holds PD4/PD7. The other `swd` subcommands and
  `ncp_recover_via_swd()` both take it.
- The IWDG is fed once per page from inside the erase/program loop.

## If it goes wrong

| Symptom | Meaning |
|---|---|
| `window REJECT: crc32 ...` | Chunks were lost. The tool re-sends; harmless, and expected once or twice per image. |
| `window REJECT: short upload` | Same, caught by length rather than checksum. A run of *whole* chunks missing off the tail (the reported byte count is an exact multiple of 240) means the receiver is being outrun, not that the network is dropping packets — see below. |
| `address outside the permitted region` | The HEX is not the NCP application image — check it starts at `0x1000`. |
| `read-back did not match` | A page did not take the program. The image on the part is bad; reflash. |
| `image incomplete (no EOF record)` | The upload lost its tail. Nothing was programmed — the check runs before the last page is flushed. |
| `AP0 blocked (APPROTECT / bootloader)` | Stuck in DFU via GPREGRET. Needs a power cycle. |

An aborted or failed flash leaves a partial image. The part will not boot, but
`swd flash` can still reach it — AP0 only closes when an application engages
APPROTECT, and a part with no working application never gets that far.

### Upload throughput

The receiver is the limit, not the network. `stream_task_func()` drains up to
`STREAM_RX_DRAIN_MAX` datagrams per loop pass into a 32-deep UDP mailbox; push
faster than it drains and the overflow is dropped with no indication at either
end. That is what the per-window CRC is for.

If a window is rejected repeatedly with a byte count that is an exact multiple
of 240, the sender is outrunning the board — lower `CHUNKS_PER_BATCH` or raise
`BATCH_PAUSE_MS` in `ncp-flash.ts`. Before this was tuned, four mailbox slots
and a one-datagram-per-pass drain lost the tail of every single window.

**`tools/cca/ota-upload.ts` shares the transport and has no integrity check at
all.** It paces the same way this tool used to, so LDF bodies it uploads can
arrive with holes and nothing will say so. Treat a failed PowPak OTA with that
in mind.

## What a good run looks like

```
[ncp-flash] image 0x00001000..0x00037fb8, 225208 bytes in 11 windows of <=61440
flash session open: region 00001000..000E0000, core halted
[ncp-flash] window 1/11: window 1 ok: 61425 bytes fed, 21840 image bytes, 5 pages written
...
flash OK: 225208 bytes, 55 pages, verified
reset issued — CCX task is re-probing and re-pushing Thread credentials
[ncp-flash] rejoined Thread as ROUTER
```

A window or two rejecting on CRC and succeeding on the retry is normal.

Two things worth checking afterwards, because they are the ones that fail
quietly:

- `swd` should report **APPROTECT open**. The factory bootloader never clears
  APPROTECT and the OpenThread application does, so an open AP0 is positive
  evidence the *application* booted rather than the bootloader.
- `status` should show **`swd_recoveries=0`**. A nonzero count means the
  liveness watchdog had to rescue the NCP 30 s later — the flash worked, but
  the automatic credential push did not, and that is a bug rather than a
  successful recovery.

## Related

- [tooling/nucleo.md](nucleo.md) — board, toolchain, wiring
- `firmware/src/swd/nrf_flash.h` — the driver and the rules it enforces
- `firmware/tests/test_nrf_flash.cpp` — what is pinned, and why
