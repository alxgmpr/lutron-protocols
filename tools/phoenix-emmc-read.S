@ emmc-read.S — Standalone eMMC reader for AM335x (Phoenix) via UART boot
@ Reads eMMC sectors into OCMC RAM (no DDR needed) and dumps hex over UART
@ Probes MMC0, MMC1, MMC2 to find the eMMC automatically
@
@ Protocol (over UART at 115200):
@   ARM prints "READY\r\n" when eMMC is initialized
@   Host sends "R XXXXXXXX\r\n" to read sector XXXXXXXX (hex)
@   ARM replies: "S XXXXXXXX\r\n" + 32 lines of 16 hex bytes + "E\r\n"
@   Host sends "D XXXXXXXX YYYYYYYY\r\n" to dump YYYYYYYY sectors from XXXXXXXX
@   Host sends "I\r\n" for card info

    .syntax unified
    .arm
    .section .text
    .global _start

@ ---- Constants ----
.equ UART_BASE,     0x44E09000
.equ UART_THR,      0x00
.equ UART_RHR,      0x00
.equ UART_LSR,      0x14
.equ UART_SYSC,     0x54

.equ WDT_BASE,      0x44E35000
.equ CM_PER,        0x44E00000
.equ CM_WKUP,       0x44E00400
.equ CTRL_MOD,      0x44E10000

.equ MMC0_BASE,     0x48060100
.equ MMC1_BASE,     0x481D8100
.equ MMC2_BASE,     0x47810100

.equ SECT_BUF,      0x402F8000     @ sector read buffer (512 bytes, in SRAM)
.equ LINE_BUF,      0x402F8400     @ UART line buffer (256 bytes, in SRAM)

@ MMC register offsets (from MMCHS base + 0x100, i.e. from our BASE defines)
.equ MMC_SYSCONFIG, 0x010
.equ MMC_SYSSTATUS, 0x014
.equ MMC_CON,       0x02C
.equ MMC_BLK,       0x104
.equ MMC_ARG,       0x108
.equ MMC_CMD,       0x10C
.equ MMC_RSP10,     0x110
.equ MMC_RSP32,     0x114
.equ MMC_RSP54,     0x118
.equ MMC_RSP76,     0x11C
.equ MMC_DATA,      0x120
.equ MMC_PSTATE,    0x124
.equ MMC_HCTL,      0x128
.equ MMC_SYSCTL,    0x12C
.equ MMC_STAT,      0x130
.equ MMC_IE,        0x134
.equ MMC_ISE,       0x138
.equ MMC_CAPA,      0x140

@ MMC CMD register encodings
@ CMD[29:24]=INDX, [21]=DP, [20]=CICE, [19]=CCCE, [17:16]=RSP, [5]=MSBS, [4]=DDIR, [2]=BCE
.equ CMD0_VAL,      0x00000000     @ GO_IDLE: no response
.equ CMD1_VAL,      0x01020000     @ SEND_OP_COND: R3 (48-bit, no checks)
.equ CMD2_VAL,      0x02090000     @ ALL_SEND_CID: R2 (136-bit), CRC
.equ CMD3_VAL,      0x031A0000     @ SET_RELATIVE_ADDR: R1, CRC+idx
.equ CMD7_VAL,      0x071B0000     @ SELECT_CARD: R1b, CRC+idx
.equ CMD16_VAL,     0x101A0000     @ SET_BLOCKLEN: R1, CRC+idx
.equ CMD17_VAL,     0x113A0010     @ READ_SINGLE_BLOCK: R1, CRC+idx, data, read
.equ CMD24_VAL,     0x183A0000     @ WRITE_SINGLE_BLOCK: R1, CRC+idx, data, write (DDIR=0)

.equ CMD1_OCR,      0x40FF8080     @ sector mode, wide voltage

@ ---- Entry Point ----
_start:
    ldr r7, =UART_BASE

    @ Immediate UART test — print 'Z' before any init
.Lwait_z:
    ldr r1, [r7, #0x14]    @ UART_LSR
    tst r1, #0x20           @ THR empty?
    beq .Lwait_z
    mov r0, #'Z'
    strb r0, [r7]

    @ Use ROM-provided SP (don't override — OCMC may be gated)

    @ === WDT disable ===
    ldr r3, =WDT_BASE
    ldr r2, =0xAAAA
    str r2, [r3, #0x48]
1:  ldr r0, [r3, #0x34]
    cmp r0, #0
    bne 1b
    ldr r2, =0x5555
    str r2, [r3, #0x48]
2:  ldr r0, [r3, #0x34]
    cmp r0, #0
    bne 2b

    @ Print 'W' = WDT done
.Lwait_w:
    ldr r1, [r7, #0x14]
    tst r1, #0x20
    beq .Lwait_w
    mov r0, #'W'
    strb r0, [r7]

    @ === Module clocks (write 2 = MODULEMODE_ENABLE) ===
    ldr r1, =CM_PER
    mov r0, #2

    str r0, [r1, #0x0E0]   @ L3
    str r0, [r1, #0x0DC]   @ L3_INSTR
    str r0, [r1, #0x060]   @ L4LS
    str r0, [r1, #0x064]   @ L4FW
    str r0, [r1, #0x120]   @ L4HS
    str r0, [r1, #0x028]   @ EMIF
    str r0, [r1, #0x02C]   @ OCMCRAM
    str r0, [r1, #0x030]   @ GPMC
    str r0, [r1, #0x06C]   @ UART0 (via CM_PER, some chips have this in WKUP)
    str r0, [r1, #0x03C]   @ MMC0
    str r0, [r1, #0x0F4]   @ MMC1
    str r0, [r1, #0x0F8]   @ MMC2
    str r0, [r1, #0x080]   @ TPCC
    str r0, [r1, #0x048]   @ I2C1 (may be needed for board detect)
    str r0, [r1, #0x014]   @ USB0
    str r0, [r1, #0x0AC]   @ GPIO1
    str r0, [r1, #0x0B0]   @ GPIO2
    str r0, [r1, #0x0B4]   @ GPIO3

    @ WKUP domain clocks
    ldr r1, =CM_WKUP
    str r0, [r1, #0x04]    @ CM_WKUP_CONTROL_CLKCTRL (offset 0x04 from CM_WKUP)
    str r0, [r1, #0x0C]    @ CM_WKUP_L3_AON_CLKSTCTRL? Actually WKUP module clocks

    @ Domain clocks (CLKSTCTRL = 2 = SW_WKUP)
    ldr r1, =CM_PER
    str r0, [r1, #0x00C]   @ L3_CLKSTCTRL
    str r0, [r1, #0x004]   @ L3S_CLKSTCTRL
    str r0, [r1, #0x000]   @ L4LS_CLKSTCTRL
    str r0, [r1, #0x008]   @ L4FW_CLKSTCTRL
    str r0, [r1, #0x11C]   @ L4HS_CLKSTCTRL

    ldr r1, =CM_WKUP
    str r0, [r1, #0x00]    @ CM_WKUP_CLKSTCTRL
    str r0, [r1, #0x04]    @ WKUP_L3_AON_CLKSTCTRL

    @ Print 'C' = clocks done
.Lwait_c:
    ldr r1, [r7, #0x14]
    tst r1, #0x20
    beq .Lwait_c
    mov r0, #'C'
    strb r0, [r7]

    @ UART no-idle (SYSC IDLEMODE = 1)
    add r1, r7, #0x54
    ldr r0, [r1]
    orr r0, r0, #0x08      @ IDLEMODE = 1 (no-idle)
    bic r0, r0, #0x10
    str r0, [r1]

    @ Brief delay for clocks to settle
    ldr r0, =100000
3:  subs r0, r0, #1
    bne 3b

    @ === Banner ===
    ldr r0, =msg_banner
    bl puts

    @ Read and print CONTROL_STATUS (SYSBOOT value)
    ldr r1, =0x44E10040     @ CONTROL_STATUS
    ldr r0, [r1]
    bl puthex32
    bl print_crlf

    @ === eMMC reset toggle ===
    @ Try common eMMC RST# GPIOs — drive HIGH to release from reset
    @ GPIO1_20 (BBB standard): pin gpmc_a4 (offset 0x850)
    ldr r1, =0x44E10000
    mov r0, #0x07           @ mode 7 (GPIO), output
    str r0, [r1, #0x850]   @ gpmc_a4 → GPIO1_20

    @ Also try GPIO2_1 and GPIO1_29 as common alternatives
    str r0, [r1, #0x844]   @ gpmc_a1 → GPIO1_17 (another possible reset)
    str r0, [r1, #0x87C]   @ gpmc_csn0 → GPIO1_29

    @ Drive all candidate GPIOs HIGH (release reset)
    ldr r1, =0x4804C000     @ GPIO1 base
    ldr r0, [r1, #0x134]    @ GPIO1_OE
    bic r0, r0, #(1 << 20)  @ bit 20 = output
    bic r0, r0, #(1 << 17)
    bic r0, r0, #(1 << 29)
    str r0, [r1, #0x134]
    ldr r0, =(1 << 20) | (1 << 17) | (1 << 29)
    str r0, [r1, #0x194]    @ GPIO1_SETDATAOUT

    @ Delay for reset to take effect (~1ms)
    ldr r0, =500000
4:  subs r0, r0, #1
    bne 4b

    mov r0, #'R'
    bl uart_putc

    @ === Pin mux for MMC0 (dedicated pins, mode 0, input, pull-up) ===
    ldr r1, =0x44E10000     @ Control Module base
    ldr r0, =0x30           @ mode 0, input, pull-up
    str r0, [r1, #0x8F0]   @ mmc0_dat3
    str r0, [r1, #0x8F4]   @ mmc0_dat2
    str r0, [r1, #0x8F8]   @ mmc0_dat1
    str r0, [r1, #0x8FC]   @ mmc0_dat0
    str r0, [r1, #0x900]   @ mmc0_clk
    str r0, [r1, #0x904]   @ mmc0_cmd

    @ === Pin mux for MMC1 (GPMC AD0-7 → mode 1, csn1/csn2 → mode 2) ===
    ldr r0, =0x31           @ mode 1, input, pull-up
    str r0, [r1, #0x800]   @ gpmc_ad0 → mmc1_dat0
    str r0, [r1, #0x804]   @ gpmc_ad1 → mmc1_dat1
    str r0, [r1, #0x808]   @ gpmc_ad2 → mmc1_dat2
    str r0, [r1, #0x80C]   @ gpmc_ad3 → mmc1_dat3
    str r0, [r1, #0x810]   @ gpmc_ad4 → mmc1_dat4
    str r0, [r1, #0x814]   @ gpmc_ad5 → mmc1_dat5
    str r0, [r1, #0x818]   @ gpmc_ad6 → mmc1_dat6
    str r0, [r1, #0x81C]   @ gpmc_ad7 → mmc1_dat7
    ldr r0, =0x22           @ mode 2, input (clock feedback)
    str r0, [r1, #0x880]   @ gpmc_csn1 → mmc1_clk
    ldr r0, =0x32           @ mode 2, input, pull-up
    str r0, [r1, #0x884]   @ gpmc_csn2 → mmc1_cmd

    @ === Pin mux for MMC2 (GPMC AD8-15 → mode 3, clk/csn3 → mode 3) ===
    ldr r0, =0x33           @ mode 3, input, pull-up
    str r0, [r1, #0x820]   @ gpmc_ad8  → mmc2_dat4
    str r0, [r1, #0x824]   @ gpmc_ad9  → mmc2_dat5
    str r0, [r1, #0x828]   @ gpmc_ad10 → mmc2_dat6
    str r0, [r1, #0x82C]   @ gpmc_ad11 → mmc2_dat7
    str r0, [r1, #0x830]   @ gpmc_ad12 → mmc2_dat0
    str r0, [r1, #0x834]   @ gpmc_ad13 → mmc2_dat1
    str r0, [r1, #0x838]   @ gpmc_ad14 → mmc2_dat2
    str r0, [r1, #0x83C]   @ gpmc_ad15 → mmc2_dat3
    mov r0, #0x03           @ mode 3, output
    str r0, [r1, #0x88C]   @ gpmc_clk  → mmc2_clk
    ldr r0, =0x33           @ mode 3, input, pull-up
    str r0, [r1, #0x888]   @ gpmc_csn3 → mmc2_cmd

    @ Print 'P' = pin mux done
    mov r0, #'P'
    bl uart_putc

    @ === Probe MMC controllers ===
    ldr r0, =msg_probe
    bl puts

    @ Try MMC0
    ldr r0, =msg_mmc0
    bl puts
    ldr r8, =MMC0_BASE
    bl mmc_probe
    cmp r0, #0
    beq found_emmc

    @ Try MMC1
    ldr r0, =msg_mmc1
    bl puts
    ldr r8, =MMC1_BASE
    bl mmc_probe
    cmp r0, #0
    beq found_emmc

    @ Try MMC2 (GPMC pins)
    ldr r0, =msg_mmc2
    bl puts
    ldr r8, =MMC2_BASE
    bl mmc_probe
    cmp r0, #0
    beq found_emmc

    @ Try MMC2 again with LCD data pins (alternative mapping)
    ldr r0, =msg_mmc2_lcd
    bl puts
    ldr r1, =0x44E10000
    ldr r0, =0x33           @ mode 3, input, pull-up
    str r0, [r1, #0x8A0]   @ lcd_data0 → mmc2_dat0
    str r0, [r1, #0x8A4]   @ lcd_data1 → mmc2_dat1
    str r0, [r1, #0x8A8]   @ lcd_data2 → mmc2_dat2
    str r0, [r1, #0x8AC]   @ lcd_data3 → mmc2_dat3
    str r0, [r1, #0x8B0]   @ lcd_data4 → mmc2_dat4
    str r0, [r1, #0x8B4]   @ lcd_data5 → mmc2_dat5
    str r0, [r1, #0x8B8]   @ lcd_data6 → mmc2_dat6
    str r0, [r1, #0x8BC]   @ lcd_data7 → mmc2_dat7
    @ CLK and CMD stay on GPMC pins (same as above)
    ldr r8, =MMC2_BASE
    bl mmc_probe
    cmp r0, #0
    beq found_emmc

    @ None found
    ldr r0, =msg_no_emmc
    bl puts
    b hang

found_emmc:
    ldr r0, =msg_found
    bl puts
    @ r8 = working MMC base

    @ Full eMMC init (CMD2, CMD3, CMD7, CMD16)
    bl emmc_card_init
    cmp r0, #0
    bne emmc_init_fail

    ldr r0, =msg_ready
    bl puts

    @ === Main command loop ===
cmd_loop:
    mov r0, #'>'
    bl uart_putc
    mov r0, #' '
    bl uart_putc

    ldr r10, =LINE_BUF
    bl uart_getline

    @ Check first char
    ldrb r0, [r10]
    cmp r0, #'R'
    beq do_read_cmd
    cmp r0, #'r'
    beq do_read_cmd
    cmp r0, #'D'
    beq do_dump_cmd
    cmp r0, #'d'
    beq do_dump_cmd
    cmp r0, #'I'
    beq do_info_cmd
    cmp r0, #'i'
    beq do_info_cmd
    cmp r0, #'P'
    beq do_patch_cmd
    cmp r0, #'p'
    beq do_patch_cmd
    cmp r0, #0
    beq cmd_loop          @ empty line, just prompt again

    ldr r0, =msg_help
    bl puts
    b cmd_loop

@ ---- R <sector_hex> : read and dump one sector ----
do_read_cmd:
    add r0, r10, #2        @ skip "R "
    bl parse_hex
    mov r4, r0              @ r4 = sector number

    mov r0, r4
    bl read_sector
    cmp r0, #0
    bne read_err

    mov r0, r4
    bl dump_sector_hex
    b cmd_loop

read_err:
    ldr r0, =msg_read_err
    bl puts
    b cmd_loop

@ ---- D <start_hex> <count_hex> : dump range of sectors ----
do_dump_cmd:
    add r0, r10, #2
    bl parse_hex
    mov r4, r0              @ r4 = start sector

    @ Find next space/argument
    add r0, r10, #2
    bl skip_to_space
    bl parse_hex
    mov r5, r0              @ r5 = count
    cmp r5, #0
    beq cmd_loop

dump_range_loop:
    cmp r5, #0
    beq cmd_loop

    mov r0, r4
    bl read_sector
    cmp r0, #0
    bne dump_range_err

    mov r0, r4
    bl dump_sector_hex

    add r4, r4, #1
    subs r5, r5, #1
    b dump_range_loop

dump_range_err:
    ldr r0, =msg_read_err
    bl puts
    b cmd_loop

@ ---- I : print eMMC info ----
do_info_cmd:
    ldr r0, =msg_info_hdr
    bl puts
    @ Print MMC base address
    mov r0, r8
    sub r0, r0, #0x100     @ module base
    bl puthex32
    bl print_crlf
    b cmd_loop

@ ---- P SECTOR OFFSET OLD NEW : patch one byte (read-verify-write-verify) ----
@ Format: P 00013F00 E5 23 20
@   → reads sector 0x13F00, checks byte at offset 0xE5 == 0x23, writes 0x20, re-reads to verify
do_patch_cmd:

    @ Parse sector number
    add r0, r10, #2
    bl parse_hex
    mov r4, r0              @ r4 = sector

    @ Parse byte offset within sector
    add r0, r10, #2
    bl skip_to_space
    bl parse_hex
    mov r5, r0              @ r5 = offset (0-511)

    @ Parse expected old byte
    mov r0, r10
    add r0, r0, #2
    bl skip_to_space
    bl skip_to_space
    bl parse_hex
    mov r6, r0              @ r6 = old byte

    @ Parse new byte
    mov r0, r10
    add r0, r0, #2
    bl skip_to_space
    bl skip_to_space
    bl skip_to_space
    bl parse_hex
    mov r11, r0             @ r11 = new byte

    @ Print what we're doing
    ldr r0, =msg_patch_read
    bl puts
    mov r0, r4
    bl puthex32
    mov r0, #'+'
    bl uart_putc
    mov r0, r5
    bl puthex32
    bl print_crlf

    @ Step 1: Read the sector
    mov r0, r4
    bl read_sector
    cmp r0, #0
    bne .Lpatch_read_fail

    @ Step 2: Verify old byte matches
    ldr r0, =SECT_BUF
    ldrb r1, [r0, r5]      @ byte at offset
    cmp r1, r6
    bne .Lpatch_verify_fail

    @ Step 3: Write new byte
    ldr r0, =SECT_BUF
    strb r11, [r0, r5]

    @ Step 4: Write sector back
    ldr r0, =msg_patch_write
    bl puts
    mov r0, r4
    bl write_sector
    cmp r0, #0
    bne .Lpatch_write_fail

    @ Step 5: Re-read and verify
    ldr r0, =msg_patch_verify
    bl puts
    mov r0, r4
    bl read_sector
    cmp r0, #0
    bne .Lpatch_read_fail

    ldr r0, =SECT_BUF
    ldrb r1, [r0, r5]
    cmp r1, r11
    bne .Lpatch_final_fail

    @ Success!
    ldr r0, =msg_patch_ok
    bl puts
    b cmd_loop

.Lpatch_read_fail:
    ldr r0, =msg_read_err
    bl puts
    b cmd_loop

.Lpatch_verify_fail:
    @ Print what we found vs expected
    ldr r0, =msg_patch_mismatch
    bl puts
    mov r0, r1
    bl puthex8
    ldr r0, =msg_patch_expected
    bl puts
    mov r0, r6
    bl puthex8
    bl print_crlf
    b cmd_loop

.Lpatch_write_fail:
    ldr r0, =msg_patch_wfail
    bl puts
    pop {r4-r7, pc}

.Lpatch_final_fail:
    ldr r0, =msg_patch_vfail
    bl puts
    mov r0, r1
    bl puthex8
    bl print_crlf
    b cmd_loop

emmc_init_fail:
    ldr r0, =msg_emmc_fail
    bl puts
hang:
    b hang

    .ltorg  @ literal pool #1

@ ========================================================
@ mmc_probe: Reset controller, init, try CMD0+CMD1
@ Input: r8 = MMC base
@ Output: r0 = 0 if eMMC found, -1 if not
@ ========================================================
mmc_probe:
    push {r4-r6, lr}

    @ 1. Soft reset
    mov r0, #2
    str r0, [r8, #MMC_SYSCONFIG]

    ldr r4, =200000
.Lprobe_rst:
    ldr r0, [r8, #MMC_SYSSTATUS]
    tst r0, #1              @ RESETDONE
    bne .Lprobe_rst_ok
    subs r4, r4, #1
    bne .Lprobe_rst
    @ Timeout
    mov r0, #'T'
    bl uart_putc
    mov r0, #-1
    pop {r4-r6, pc}

.Lprobe_rst_ok:
    @ Print revision
    ldr r0, [r8, #-0x100]  @ HL_REV at module_base + 0
    mov r6, r0
    mov r0, #'v'
    bl uart_putc
    mov r0, r6
    bl puthex32
    mov r0, #' '
    bl uart_putc

    @ 2. Set capabilities (ensure 3.3V)
    ldr r0, [r8, #MMC_CAPA]
    orr r0, r0, #(1 << 24) @ VS33
    str r0, [r8, #MMC_CAPA]

    @ 3. Set bus voltage 3.3V
    ldr r0, [r8, #MMC_HCTL]
    bic r0, r0, #(7 << 9)
    orr r0, r0, #(7 << 9)  @ SDVS = 3.3V
    str r0, [r8, #MMC_HCTL]

    @ 4. Enable bus power
    ldr r0, [r8, #MMC_HCTL]
    orr r0, r0, #(1 << 8)  @ SDBP
    str r0, [r8, #MMC_HCTL]

    ldr r4, =200000
.Lprobe_pwr:
    ldr r0, [r8, #MMC_HCTL]
    tst r0, #(1 << 8)
    bne .Lprobe_pwr_ok
    subs r4, r4, #1
    bne .Lprobe_pwr
.Lprobe_pwr_ok:

    @ 5. Set clock: ICE=1, CLKD=240 (0xF0) for ~400kHz, DTO=0xE
    ldr r0, [r8, #MMC_SYSCTL]
    ldr r2, =0x000EFFC7     @ mask: DTO + CLKD + CEN + ICS + ICE
    bic r0, r0, r2
    ldr r2, =0x000E3C01     @ DTO=0xE, CLKD=0xF0, ICE=1
    orr r0, r0, r2
    str r0, [r8, #MMC_SYSCTL]

    @ Wait for ICS (internal clock stable)
    ldr r4, =200000
.Lprobe_ics:
    ldr r0, [r8, #MMC_SYSCTL]
    tst r0, #2              @ ICS
    bne .Lprobe_ics_ok
    subs r4, r4, #1
    bne .Lprobe_ics
.Lprobe_ics_ok:

    @ Enable clock to card (CEN)
    ldr r0, [r8, #MMC_SYSCTL]
    orr r0, r0, #4          @ CEN
    str r0, [r8, #MMC_SYSCTL]

    @ Print SYSCTL for verification
    mov r0, #'s'
    bl uart_putc
    ldr r0, [r8, #MMC_SYSCTL]
    bl puthex32
    mov r0, #' '
    bl uart_putc

    @ 6. Enable all status interrupts
    mvn r0, #0
    str r0, [r8, #MMC_IE]
    str r0, [r8, #MMC_ISE]

    @ 7. Send init stream (80 clocks)
    ldr r0, [r8, #MMC_CON]
    orr r0, r0, #2          @ INIT
    str r0, [r8, #MMC_CON]

    mov r0, #0
    str r0, [r8, #MMC_CMD]  @ CMD0 with init stream
    ldr r4, =200000
.Linit1:
    ldr r0, [r8, #MMC_STAT]
    tst r0, #1              @ CC
    bne .Linit1_ok
    subs r4, r4, #1
    bne .Linit1
.Linit1_ok:
    mvn r0, #0
    str r0, [r8, #MMC_STAT] @ clear status

    mov r0, #0
    str r0, [r8, #MMC_CMD]  @ CMD0 again
    ldr r4, =200000
.Linit2:
    ldr r0, [r8, #MMC_STAT]
    tst r0, #1
    bne .Linit2_ok
    subs r4, r4, #1
    bne .Linit2
.Linit2_ok:
    mvn r0, #0
    str r0, [r8, #MMC_STAT]

    @ Clear INIT bit
    ldr r0, [r8, #MMC_CON]
    bic r0, r0, #2
    str r0, [r8, #MMC_CON]

    @ 8. Send CMD0 (GO_IDLE)
    mov r0, #'0'
    bl uart_putc
    mov r1, #0
    ldr r0, =CMD0_VAL
    bl send_mmc_cmd
    @ CMD0 has no response, may timeout — OK

    mvn r0, #0
    str r0, [r8, #MMC_STAT]

    @ 9. CMD1 probe — fast fail if no card
    @ First try: if timeout → no card, bail immediately
    mov r0, #'1'
    bl uart_putc
    ldr r1, =CMD1_OCR
    ldr r0, =CMD1_VAL
    bl send_mmc_cmd
    cmp r0, #0
    bne .Lcmd1_nocard        @ First CTO = no card at all

    @ Got a response — card exists. Loop until ready (bit 31)
    tst r1, #(1 << 31)
    bne .Lcmd1_ready

    @ Card busy, retry up to 100 times
    mov r6, #1
.Lcmd1_loop:
    ldr r0, =5000
.Lcmd1_dly:
    subs r0, r0, #1
    bne .Lcmd1_dly

    ldr r1, =CMD1_OCR
    ldr r0, =CMD1_VAL
    bl send_mmc_cmd
    cmp r0, #0
    bne .Lcmd1_nocard

    tst r1, #(1 << 31)
    bne .Lcmd1_ready

    add r6, r6, #1
    cmp r6, #100
    blt .Lcmd1_loop

.Lcmd1_nocard:
    @ Print STAT for diagnostics
    mov r0, #'X'
    bl uart_putc
    ldr r0, [r8, #MMC_STAT]
    bl puthex32
    bl print_crlf
    mov r0, #-1
    pop {r4-r6, pc}

.Lcmd1_ready:
    @ eMMC found and ready!
    mov r0, #'!'
    bl uart_putc
    bl print_crlf
    mov r0, #0
    pop {r4-r6, pc}

    .ltorg  @ literal pool #2

@ ========================================================
@ emmc_card_init: CMD2, CMD3, CMD7, CMD16
@ Input: r8 = MMC base (controller already initialized, CMD1 done)
@ Output: r0 = 0 success, -1 fail
@ ========================================================
emmc_card_init:
    push {r4-r5, lr}

    @ CMD2 — ALL_SEND_CID
    mov r0, #'2'
    bl uart_putc
    mov r1, #0
    ldr r0, =CMD2_VAL
    bl send_mmc_cmd
    cmp r0, #0
    bne .Lcard_fail

    @ CMD3 — SET_RELATIVE_ADDR (RCA=1)
    mov r0, #'3'
    bl uart_putc
    ldr r1, =0x00010000    @ RCA = 1 in bits 31:16
    ldr r0, =CMD3_VAL
    bl send_mmc_cmd
    cmp r0, #0
    bne .Lcard_fail

    @ CMD7 — SELECT_CARD
    mov r0, #'7'
    bl uart_putc
    ldr r1, =0x00010000    @ RCA = 1
    ldr r0, =CMD7_VAL
    bl send_mmc_cmd
    cmp r0, #0
    bne .Lcard_fail

    @ CMD16 — SET_BLOCKLEN = 512
    mov r0, #'B'
    bl uart_putc
    ldr r1, =512
    ldr r0, =CMD16_VAL
    bl send_mmc_cmd
    cmp r0, #0
    bne .Lcard_fail

    mov r0, #' '
    bl uart_putc
    mov r0, #'O'
    bl uart_putc
    mov r0, #'K'
    bl uart_putc
    bl print_crlf

    mov r0, #0
    pop {r4-r5, pc}

.Lcard_fail:
    bl print_crlf
    mov r0, #-1
    pop {r4-r5, pc}

@ ========================================================
@ send_mmc_cmd: Send command to MMC controller
@ Input: r0 = CMD register value, r1 = ARG value
@ Output: r0 = 0 success / -1 error, r1 = RSP10
@ ========================================================
send_mmc_cmd:
    push {r2-r4, lr}
    mov r3, r0              @ save CMD
    mov r4, r1              @ save ARG

    @ Wait for command line free
    ldr r2, =200000
.Lscmd_free:
    ldr r0, [r8, #MMC_PSTATE]
    tst r0, #1              @ CMDI
    beq .Lscmd_go
    subs r2, r2, #1
    bne .Lscmd_free
    mov r0, #-1
    pop {r2-r4, pc}

.Lscmd_go:
    @ Clear all status
    mvn r0, #0
    str r0, [r8, #MMC_STAT]

    @ Set argument
    str r4, [r8, #MMC_ARG]

    @ Send command
    str r3, [r8, #MMC_CMD]

    @ Wait for CC or ERRI (CTO fires in ~64ms at 200kHz card clock)
    @ At 500MHz CPU, need ~32M iterations. Use 5M for safety.
    ldr r2, =5000000
.Lscmd_wait:
    ldr r0, [r8, #MMC_STAT]
    tst r0, #(1 << 15)     @ ERRI
    bne .Lscmd_err
    tst r0, #1              @ CC
    bne .Lscmd_ok
    subs r2, r2, #1
    bne .Lscmd_wait
    @ Software timeout — print STAT before returning
    mov r0, #'t'
    bl uart_putc
    ldr r0, [r8, #MMC_STAT]
    bl puthex32
    mov r0, #-1
    pop {r2-r4, pc}

.Lscmd_err:
    @ Hardware error — print STAT for diagnosis
    mov r0, #'e'
    bl uart_putc
    ldr r0, [r8, #MMC_STAT]
    bl puthex32
    @ Clear status
    mvn r0, #0
    str r0, [r8, #MMC_STAT]
    mov r0, #-1
    pop {r2-r4, pc}

.Lscmd_ok:
    @ Read response
    ldr r1, [r8, #MMC_RSP10]
    mov r0, #0
    pop {r2-r4, pc}

@ ========================================================
@ read_sector: Read one 512-byte sector from eMMC
@ Input: r0 = sector number
@ Output: r0 = 0 success / -1 error, data at OCMC_BUF
@ ========================================================
read_sector:
    push {r4-r6, lr}
    mov r4, r0              @ sector number

    @ Set block size + count
    ldr r0, =(1 << 16) | 512   @ 1 block, 512 bytes
    str r0, [r8, #MMC_BLK]

    @ Clear status
    mvn r0, #0
    str r0, [r8, #MMC_STAT]

    @ Wait for data line free
    ldr r2, =200000
.Lrs_dfree:
    ldr r0, [r8, #MMC_PSTATE]
    tst r0, #2              @ DATI
    beq .Lrs_go
    subs r2, r2, #1
    bne .Lrs_dfree
.Lrs_go:

    @ Send CMD17 (READ_SINGLE_BLOCK)
    str r4, [r8, #MMC_ARG]
    ldr r0, =CMD17_VAL
    str r0, [r8, #MMC_CMD]

    @ Wait for CC (command complete)
    ldr r2, =500000
.Lrs_cc:
    ldr r0, [r8, #MMC_STAT]
    tst r0, #(1 << 15)     @ ERRI
    bne .Lrs_err
    tst r0, #1              @ CC
    bne .Lrs_cc_ok
    subs r2, r2, #1
    bne .Lrs_cc
    mov r0, #-1
    pop {r4-r6, pc}
.Lrs_cc_ok:

    @ Wait for BRR (buffer read ready)
    ldr r2, =500000
.Lrs_brr:
    ldr r0, [r8, #MMC_STAT]
    tst r0, #(1 << 15)     @ ERRI
    bne .Lrs_err
    tst r0, #(1 << 5)      @ BRR
    bne .Lrs_brr_ok
    subs r2, r2, #1
    bne .Lrs_brr
    mov r0, #-1
    pop {r4-r6, pc}
.Lrs_brr_ok:

    @ Read 128 words (512 bytes) from DATA register
    ldr r5, =SECT_BUF
    mov r6, #128
.Lrs_read:
    ldr r0, [r8, #MMC_DATA]
    str r0, [r5], #4
    subs r6, r6, #1
    bne .Lrs_read

    @ Wait for TC (transfer complete)
    ldr r2, =500000
.Lrs_tc:
    ldr r0, [r8, #MMC_STAT]
    tst r0, #(1 << 1)      @ TC
    bne .Lrs_tc_ok
    subs r2, r2, #1
    bne .Lrs_tc
.Lrs_tc_ok:

    @ Clear all status
    mvn r0, #0
    str r0, [r8, #MMC_STAT]

    mov r0, #0
    pop {r4-r6, pc}

.Lrs_err:
    @ Print error status for debug
    ldr r0, [r8, #MMC_STAT]
    bl puthex32
    @ Clear
    mvn r0, #0
    str r0, [r8, #MMC_STAT]
    mov r0, #-1
    pop {r4-r6, pc}

    .ltorg  @ literal pool #3

@ ========================================================
@ write_sector: Write one 512-byte sector to eMMC from SECT_BUF
@ Input: r0 = sector number
@ Output: r0 = 0 success / -1 error
@ ========================================================
write_sector:
    push {r4-r6, lr}
    mov r4, r0              @ sector number

    @ Set block size + count
    ldr r0, =(1 << 16) | 512
    str r0, [r8, #MMC_BLK]

    @ Clear status
    mvn r0, #0
    str r0, [r8, #MMC_STAT]

    @ Wait for data line free
    ldr r2, =200000
.Lws_dfree:
    ldr r0, [r8, #MMC_PSTATE]
    tst r0, #2              @ DATI
    beq .Lws_go
    subs r2, r2, #1
    bne .Lws_dfree
.Lws_go:

    @ Send CMD24 (WRITE_SINGLE_BLOCK)
    str r4, [r8, #MMC_ARG]
    ldr r0, =CMD24_VAL
    str r0, [r8, #MMC_CMD]

    @ Wait for CC (command accepted)
    ldr r2, =5000000
.Lws_cc:
    ldr r0, [r8, #MMC_STAT]
    tst r0, #(1 << 15)     @ ERRI
    bne .Lws_err
    tst r0, #1              @ CC
    bne .Lws_cc_ok
    subs r2, r2, #1
    bne .Lws_cc
    mov r0, #-1
    pop {r4-r6, pc}
.Lws_cc_ok:

    @ Wait for BWR (buffer write ready)
    ldr r2, =5000000
.Lws_bwr:
    ldr r0, [r8, #MMC_STAT]
    tst r0, #(1 << 15)     @ ERRI
    bne .Lws_err
    tst r0, #(1 << 4)      @ BWR
    bne .Lws_bwr_ok
    subs r2, r2, #1
    bne .Lws_bwr
    mov r0, #-1
    pop {r4-r6, pc}
.Lws_bwr_ok:

    @ Write 128 words (512 bytes) from SECT_BUF to DATA register
    ldr r5, =SECT_BUF
    mov r6, #128
.Lws_write:
    ldr r0, [r5], #4
    str r0, [r8, #MMC_DATA]
    subs r6, r6, #1
    bne .Lws_write

    @ Wait for TC (transfer complete)
    ldr r2, =5000000
.Lws_tc:
    ldr r0, [r8, #MMC_STAT]
    tst r0, #(1 << 15)     @ ERRI
    bne .Lws_err
    tst r0, #(1 << 1)      @ TC
    bne .Lws_tc_ok
    subs r2, r2, #1
    bne .Lws_tc
.Lws_tc_ok:

    @ Clear all status
    mvn r0, #0
    str r0, [r8, #MMC_STAT]

    mov r0, #0
    pop {r4-r6, pc}

.Lws_err:
    ldr r0, [r8, #MMC_STAT]
    bl puthex32
    mvn r0, #0
    str r0, [r8, #MMC_STAT]
    mov r0, #-1
    pop {r4-r6, pc}

    .ltorg  @ literal pool #5 (after write_sector + patch)

@ ========================================================
@ dump_sector_hex: Print 512 bytes at SECT_BUF as hex
@ Input: r0 = sector number (for header)
@ Output: none
@ ========================================================
dump_sector_hex:
    push {r4-r7, lr}
    mov r4, r0              @ sector number

    @ "S XXXXXXXX\r\n"
    mov r0, #'S'
    bl uart_putc
    mov r0, #' '
    bl uart_putc
    mov r0, r4
    bl puthex32
    bl print_crlf

    @ 32 lines of 16 bytes each
    ldr r5, =SECT_BUF
    mov r6, #32             @ lines
.Ldsh_line:
    mov r12, #4              @ words per line
.Ldsh_word:
    ldr r0, [r5], #4
    @ Print 4 bytes in little-endian order (address order)
    bl put_word_le
    subs r12, r12, #1
    bne .Ldsh_word

    bl print_crlf

    subs r6, r6, #1
    bne .Ldsh_line

    @ "E\r\n"
    mov r0, #'E'
    bl uart_putc
    bl print_crlf

    @ Restore r7 (UART base — may have been clobbered if we used it as scratch)
    ldr r7, =UART_BASE
    pop {r4-r7, pc}

@ ========================================================
@ put_word_le: Print 32-bit word as 4 hex bytes in little-endian order
@ Input: r0 = word
@ ========================================================
put_word_le:
    push {r4-r5, lr}
    mov r4, r0

    @ Byte 0 (bits 7:0)
    and r0, r4, #0xFF
    bl puthex8
    mov r0, #' '
    bl uart_putc

    @ Byte 1 (bits 15:8)
    mov r0, r4, lsr #8
    and r0, r0, #0xFF
    bl puthex8
    mov r0, #' '
    bl uart_putc

    @ Byte 2 (bits 23:16)
    mov r0, r4, lsr #16
    and r0, r0, #0xFF
    bl puthex8
    mov r0, #' '
    bl uart_putc

    @ Byte 3 (bits 31:24)
    mov r0, r4, lsr #24
    bl puthex8
    mov r0, #' '
    bl uart_putc

    pop {r4-r5, pc}

    .ltorg  @ literal pool #4

@ ========================================================
@ UART I/O
@ ========================================================

@ print_crlf: Print \r\n without using string table
print_crlf:
    push {r0, lr}
    mov r0, #'\r'
    bl uart_putc
    mov r0, #'\n'
    bl uart_putc
    pop {r0, pc}

@ uart_putc: Send one byte over UART
@ Input: r0 = byte
uart_putc:
    push {r1, lr}
.Lupc_wait:
    ldr r1, [r7, #UART_LSR]
    tst r1, #0x20           @ THR empty
    beq .Lupc_wait
    strb r0, [r7, #UART_THR]
    pop {r1, pc}

@ uart_getc: Read one byte from UART
@ Output: r0 = byte
uart_getc:
    push {r1, lr}
.Lugc_wait:
    ldr r1, [r7, #UART_LSR]
    tst r1, #0x01           @ Data Ready
    beq .Lugc_wait
    ldrb r0, [r7, #UART_RHR]
    pop {r1, pc}

@ puts: Print null-terminated string
@ Input: r0 = string pointer
puts:
    push {r4, lr}
    mov r4, r0
.Lputs_loop:
    ldrb r0, [r4], #1
    cmp r0, #0
    beq .Lputs_done
    bl uart_putc
    b .Lputs_loop
.Lputs_done:
    pop {r4, pc}

@ puthex32: Print 32-bit value as 8 hex digits
@ Input: r0 = value
puthex32:
    push {r4-r5, lr}
    mov r5, r0
    mov r4, #28
.Lph32:
    lsr r0, r5, r4
    and r0, r0, #0xF
    cmp r0, #10
    addge r0, r0, #('A' - 10)
    addlt r0, r0, #'0'
    bl uart_putc
    subs r4, r4, #4
    bge .Lph32
    pop {r4-r5, pc}

@ puthex8: Print 8-bit value as 2 hex digits
@ Input: r0 = byte (0-255)
puthex8:
    push {r4, lr}
    mov r4, r0

    mov r0, r4, lsr #4
    and r0, r0, #0xF
    cmp r0, #10
    addge r0, r0, #('A' - 10)
    addlt r0, r0, #'0'
    bl uart_putc

    and r0, r4, #0xF
    cmp r0, #10
    addge r0, r0, #('A' - 10)
    addlt r0, r0, #'0'
    bl uart_putc

    pop {r4, pc}

@ uart_getline: Read a line into buffer at r10, null-terminate
@ Output: r10 = buffer (unchanged), string null-terminated
uart_getline:
    push {r0-r3, lr}
    mov r1, r10             @ write pointer
    mov r2, #0              @ length
.Lgl_loop:
    bl uart_getc
    cmp r0, #'\r'
    beq .Lgl_done
    cmp r0, #'\n'
    beq .Lgl_done
    cmp r0, #0x08           @ backspace
    beq .Lgl_bs
    cmp r0, #0x7F           @ DEL
    beq .Lgl_bs
    cmp r2, #79
    bge .Lgl_loop           @ line too long, ignore
    strb r0, [r1], #1
    add r2, r2, #1
    bl uart_putc            @ echo
    b .Lgl_loop
.Lgl_bs:
    cmp r2, #0
    beq .Lgl_loop
    sub r1, r1, #1
    sub r2, r2, #1
    mov r0, #0x08
    bl uart_putc
    mov r0, #' '
    bl uart_putc
    mov r0, #0x08
    bl uart_putc
    b .Lgl_loop
.Lgl_done:
    mov r0, #0
    strb r0, [r1]           @ null terminate
    bl print_crlf
    pop {r0-r3, pc}

@ ========================================================
@ Parsing utilities
@ ========================================================

@ parse_hex: Parse hex string to 32-bit value
@ Input: r0 = pointer to string
@ Output: r0 = parsed value
parse_hex:
    push {r1-r3, lr}
    mov r1, r0
    mov r0, #0
.Lphx_loop:
    ldrb r2, [r1], #1
    cmp r2, #0
    beq .Lphx_done
    cmp r2, #' '
    beq .Lphx_done

    cmp r2, #'0'
    blt .Lphx_done
    cmp r2, #'9'
    ble .Lphx_digit
    cmp r2, #'A'
    blt .Lphx_done
    cmp r2, #'F'
    ble .Lphx_upper
    cmp r2, #'a'
    blt .Lphx_done
    cmp r2, #'f'
    bgt .Lphx_done
    sub r2, r2, #('a' - 10)
    b .Lphx_add
.Lphx_upper:
    sub r2, r2, #('A' - 10)
    b .Lphx_add
.Lphx_digit:
    sub r2, r2, #'0'
.Lphx_add:
    lsl r0, r0, #4
    orr r0, r0, r2
    b .Lphx_loop
.Lphx_done:
    pop {r1-r3, pc}

@ skip_to_space: Advance pointer past next space
@ Input: r0 = pointer
@ Output: r0 = pointer to char after space
skip_to_space:
    push {r1, lr}
.Lsts_find:
    ldrb r1, [r0], #1
    cmp r1, #0
    beq .Lsts_done
    cmp r1, #' '
    bne .Lsts_find
.Lsts_done:
    pop {r1, pc}

@ ========================================================
@ String constants
@ ========================================================
    .align 2
msg_banner:  .asciz "\r\n== Phoenix eMMC Reader v1 ==\r\n"
msg_probe:   .asciz "Probing MMC controllers...\r\n"
msg_mmc0:    .asciz "MMC0: "
msg_mmc1:    .asciz "MMC1: "
msg_mmc2:    .asciz "MMC2: "
msg_found:   .asciz "eMMC found! Initializing...\r\n"
msg_no_emmc: .asciz "ERROR: No eMMC found on any controller!\r\n"
msg_emmc_fail: .asciz "ERROR: eMMC card init failed!\r\n"
msg_ready:   .asciz "READY\r\n"
msg_help:    .asciz "R <sec> D <s> <n> P <sec> <off> <old> <new> I\r\n"
msg_read_err: .asciz "READ ERROR\r\n"
msg_info_hdr: .asciz "MMC base: "
msg_crlf:    .asciz "\r\n"
msg_cmd1_fail: .asciz "CMD1 timeout\r\n"
msg_mmc2_lcd: .asciz "MMC2-LCD: "
msg_patch_read: .asciz "PATCH: reading sector "
msg_patch_write: .asciz "PATCH: writing...\r\n"
msg_patch_verify: .asciz "PATCH: verifying...\r\n"
msg_patch_ok: .asciz "PATCH: OK!\r\n"
msg_patch_mismatch: .asciz "PATCH FAIL: found "
msg_patch_expected: .asciz " expected "
msg_patch_wfail: .asciz "PATCH FAIL: write error\r\n"
msg_patch_vfail: .asciz "PATCH FAIL: verify mismatch, got "
    .align 2
