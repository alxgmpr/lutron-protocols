# Phoenix Processor UART Boot RE

## Goal
Extract `/etc/ssl/firmwareupgrade/*` from the RA3/HWQSX Phoenix processor's eMMC to decrypt firmware updates.

## Hardware
- **SoC**: AM335x-GP rev 2.1 (TI Sitara Cortex-A8)
- **Crystal**: 26 MHz (SYSBOOT[15:14] = 3, confirmed via control_status 0x00C00358)
- **DDR**: Micron D9SHD (DDR3, same MT41K256M16 as BeagleBone Black)
- **SDRAM_CONFIG**: 0x61c04bb2 (identical to BBB)
- **eMMC**: MMC2, root at mmcblk1p16 (ext4)
- **SRAM**: 64KB at 0x402F0400, OCMC 128KB at 0x40300000 (stack at 0x4030FF20)
- **UART**: ttyS0 115200 8N1 on USART via USB-serial at /dev/tty.usbserial-4240

## UART Boot Method
1. Ground SYSBOOT2 (TP701) at power-on → AM335x ROM enters UART boot mode
2. ROM sends CCCC (XMODEM-CRC) on UART0
3. Send custom SPL via XMODEM → ROM loads to 0x402F0400 and executes
4. Custom SPL initializes DDR, receives U-Boot via YMODEM, boots to shell

## Key Findings

### UART Module State After XMODEM
After ROM's XMODEM session, the UART0 module is in a state where:
- **Direct register writes work** (check THRE at LSR+0x14, write THR at +0x00)
- **NS16550 UART soft reset hangs** (SYSC.SOFTRESET → SYSS.RESETDONE never set)
- **NS16550_init MDR1 toggle breaks TX** (MDR1=7→0 cycle leaves THRE stuck)
- **TEMT wait hangs** (LSR bit 6 never goes high after XMODEM)
- **set_uart_mux_conf kills output** (BBB pin mux is wrong for Phoenix UART0 routing)

**Solution**: Empty NS16550_init(), skip uart_soft_reset(), skip set_uart_mux_conf(). Leave UART at ROM's 115200 config. Use `dbg_uart_putc()` with direct register writes for debug output.

### PRCM Register Writes: ARM Stub vs C Code
A critical discovery: **writes to CM_CLKSTCTRL and CM_CLKMODE_DPLL registers crash from C code but work from the ARM entry stub**.

| Operation | ARM Stub (before cpu_init) | C Code (after cpu_init) |
|-----------|---------------------------|------------------------|
| Module CLKCTRL writes | ✓ | ✓ (with IDLEST wait=0) |
| Domain CLKSTCTRL writes | ✓ | ✗ (L3 write → system reset) |
| DPLL CM_CLKMODE writes | ✓ | ✗ (bypass/lock → hang) |
| DPLL CM_CLKSEL writes | ✓ (read) | ✗ (write hangs) |

**Theory**: After `cpu_init_cp15` enables I-cache and branch prediction, the bus access ordering for PRCM device registers changes. Thumb mode may also affect this.

**Solution**: Do all DPLL configuration and clock domain enables from the ARM entry stub, before cpu_init_cp15 runs.

### Clock Enable Sequence
The `enable_basic_clocks()` function enables ~24 module clocks with IDLEST polling. The IDLEST timeout calls `printf()` which crashes because console isn't initialized. Fix: `wait_for_enable=0`.

The `enable_clock_domain()` writes to CLKSTCTRL registers cause resets (L3 domain disruption). Fix: skip domain enables from C code, do them from ARM stub.

### DDR DPLL Configuration
DDR DPLL must be configured from the ARM entry stub:
- **Bypass**: Write 0x4 to CM_CLKMODE_DPLL_DDR (0x44E00494) DPLL_EN field
- **Wait**: Poll CM_IDLEST_DPLL_DDR (0x44E00434) bit 0 = 0
- **M/N**: Write M=800, N=25 to CM_CLKSEL_DPLL_DDR (0x44E004A0) → VCO=800MHz
- **M2**: Write M2=2 to CM_DIV_M2_DPLL_DDR (0x44E004A4) → output=400MHz
- **Lock**: Write 0x7 to CM_CLKMODE DPLL_EN field
- **Wait**: Poll IDLEST bit 0 = 1

### Current Blocker: DDR Init
`sdram_init()` → `config_ddr(400, BBB params)` crashes. The EMIF controller at 0x4C000000 likely needs the L3 clock domain in SW_WKUP mode. Adding L3 CLKSTCTRL write to the ARM stub (where it should work) is the next step.

## Custom U-Boot SPL Build
Source: `/tmp/u-boot-2017.01/` (am335x_evm config)
Key modifications:
- V_OSCK=26MHz, NS16550_init emptied, timer_init=nop with busy __udelay
- Board detection disabled, BBB DDR3 config forced
- Clock domain enables and DPLL config skipped in C (done from ARM stub)
- SPL features stripped (EXT/FAT/ENV/USB/NET) to fit in 64KB SRAM

## Tools
- `tools/phoenix-uart-boot.py` — XMODEM sender + interactive console
- `tools/phoenix-emmc-dump.py` — eMMC sector dump tool (for when DDR works)
- `/tmp/phoenix-boot/` — build artifacts, shellcode, test binaries
