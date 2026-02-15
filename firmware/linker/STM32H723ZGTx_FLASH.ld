/* Linker script for STM32H723ZGTx
 * 1 MB Flash, 320 KB DTCM + 32 KB ITCM + 128 KB AXI SRAM + 32 KB SRAM1/2/4
 *
 * Memory map (simplified for FreeRTOS + lwIP):
 *   FLASH:    Code + read-only data
 *   DTCMRAM:  Stack (main/ISR) — zero wait state, no DMA
 *   RAM_D1:   FreeRTOS heap, task stacks, general .bss/.data
 *   RAM_D2:   Ethernet DMA descriptors + buffers (must be in D2 for ETH DMA)
 *   RAM_D3:   Available for low-power retention (unused for now)
 */

ENTRY(Reset_Handler)

_estack = ORIGIN(DTCMRAM) + LENGTH(DTCMRAM);   /* Initial SP at top of DTCM */

_Min_Heap_Size  = 0x1000;    /* 4 KB (newlib sbrk — FreeRTOS uses its own heap) */
_Min_Stack_Size = 0x2000;    /* 8 KB main/ISR stack */

MEMORY
{
    FLASH    (rx)  : ORIGIN = 0x08000000, LENGTH = 896K
    FLASH_STORAGE (rw) : ORIGIN = 0x080E0000, LENGTH = 128K
    DTCMRAM  (rw)  : ORIGIN = 0x20000000, LENGTH = 128K
    RAM_D1   (rw)  : ORIGIN = 0x24000000, LENGTH = 320K
    RAM_D2   (rw)  : ORIGIN = 0x30000000, LENGTH = 32K
    RAM_D3   (rw)  : ORIGIN = 0x38000000, LENGTH = 16K
    ITCMRAM  (rw)  : ORIGIN = 0x00000000, LENGTH = 64K
}

SECTIONS
{
    /* ISR vector table — must be at start of FLASH */
    .isr_vector :
    {
        . = ALIGN(4);
        KEEP(*(.isr_vector))
        . = ALIGN(4);
    } >FLASH

    /* Code */
    .text :
    {
        . = ALIGN(4);
        *(.text)
        *(.text*)
        *(.glue_7)
        *(.glue_7t)
        *(.eh_frame)
        KEEP(*(.init))
        KEEP(*(.fini))
        . = ALIGN(4);
        _etext = .;
    } >FLASH

    /* Read-only data */
    .rodata :
    {
        . = ALIGN(4);
        *(.rodata)
        *(.rodata*)
        . = ALIGN(4);
    } >FLASH

    /* ARM exception tables */
    .ARM.extab :
    {
        *(.ARM.extab* .gnu.linkonce.armextab.*)
    } >FLASH

    .ARM :
    {
        __exidx_start = .;
        *(.ARM.exidx*)
        __exidx_end = .;
    } >FLASH

    /* C++ constructors */
    .preinit_array :
    {
        PROVIDE_HIDDEN(__preinit_array_start = .);
        KEEP(*(.preinit_array*))
        PROVIDE_HIDDEN(__preinit_array_end = .);
    } >FLASH

    .init_array :
    {
        PROVIDE_HIDDEN(__init_array_start = .);
        KEEP(*(SORT(.init_array.*)))
        KEEP(*(.init_array*))
        PROVIDE_HIDDEN(__init_array_end = .);
    } >FLASH

    .fini_array :
    {
        PROVIDE_HIDDEN(__fini_array_start = .);
        KEEP(*(SORT(.fini_array.*)))
        KEEP(*(.fini_array*))
        PROVIDE_HIDDEN(__fini_array_end = .);
    } >FLASH

    _sidata = LOADADDR(.data);

    /* Initialized data — copied from FLASH to RAM_D1 at startup */
    .data :
    {
        . = ALIGN(4);
        _sdata = .;
        *(.data)
        *(.data*)
        *(.RamFunc)
        *(.RamFunc*)
        . = ALIGN(4);
        _edata = .;
    } >RAM_D1 AT> FLASH

    /* Zero-initialized data in RAM_D1 */
    .bss :
    {
        . = ALIGN(4);
        _sbss = .;
        __bss_start__ = _sbss;
        *(.bss)
        *(.bss*)
        *(COMMON)
        . = ALIGN(4);
        _ebss = .;
        __bss_end__ = _ebss;
    } >RAM_D1

    ._user_heap_stack :
    {
        . = ALIGN(8);
        PROVIDE(end = .);
        PROVIDE(_end = .);
        . = . + _Min_Heap_Size;
        . = . + _Min_Stack_Size;
        . = ALIGN(8);
    } >DTCMRAM

    /* Ethernet DMA descriptors and buffers — MUST be in RAM_D2 (0x30000000)
     * The STM32H7 Ethernet MAC DMA can only access AHB SRAM (D2).
     * Place these with __attribute__((section(".eth_mem")))
     */
    .eth_mem (NOLOAD) :
    {
        . = ALIGN(4);
        *(.eth_mem)
        *(.eth_mem*)
        . = ALIGN(4);
    } >RAM_D2

    /* Discard debug info to save flash */
    /DISCARD/ :
    {
        libc.a(*)
        libm.a(*)
        libgcc.a(*)
    }

    .ARM.attributes 0 : { *(.ARM.attributes) }
}
