/* Linker script for the OTA bootloader (GLAB-106)
 *
 * Occupies flash sector 0 only. See STM32H723ZGTx_FLASH.ld for the full map.
 *   0    0x08000000  128K  this bootloader
 *   1-6  0x08020000  768K  application
 *   7    0x080E0000  128K  settings
 *
 * The OTA staging slot is not in this map at all — it lives on the external
 * SPI NOR (ota_flash.h), which is what freed sectors 4-6 for the application.
 *
 * The bootloader runs before the application and hands over by resetting the
 * stack pointer, so it may use any RAM — except the first 32 bytes of AXI SRAM,
 * which hold the install-request record shared with the application
 * (boot_request.h). RAM_D1 ORIGIN is moved past it here exactly as it is in the
 * application script; the two must agree.
 */

ENTRY(Reset_Handler)

_estack = ORIGIN(DTCMRAM) + LENGTH(DTCMRAM);

_Min_Heap_Size  = 0x0;      /* no heap — bootloader allocates nothing */
_Min_Stack_Size = 0x1000;   /* 4 KB */

MEMORY
{
    FLASH    (rx)  : ORIGIN = 0x08000000, LENGTH = 128K
    DTCMRAM  (rw)  : ORIGIN = 0x20000000, LENGTH = 128K
    RAM_D1   (rw)  : ORIGIN = 0x24000020, LENGTH = 320K - 32
}

SECTIONS
{
    .isr_vector :
    {
        . = ALIGN(4);
        KEEP(*(.isr_vector))
        . = ALIGN(4);
    } >FLASH

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

    .rodata :
    {
        . = ALIGN(4);
        *(.rodata)
        *(.rodata*)
        . = ALIGN(4);
    } >FLASH

    .ARM.extab : { *(.ARM.extab* .gnu.linkonce.armextab.*) } >FLASH
    .ARM : {
        __exidx_start = .;
        *(.ARM.exidx*)
        __exidx_end = .;
    } >FLASH

    .preinit_array :
    {
        PROVIDE_HIDDEN (__preinit_array_start = .);
        KEEP(*(.preinit_array*))
        PROVIDE_HIDDEN (__preinit_array_end = .);
    } >FLASH
    .init_array :
    {
        PROVIDE_HIDDEN (__init_array_start = .);
        KEEP(*(SORT(.init_array.*)))
        KEEP(*(.init_array*))
        PROVIDE_HIDDEN (__init_array_end = .);
    } >FLASH
    .fini_array :
    {
        PROVIDE_HIDDEN (__fini_array_start = .);
        KEEP(*(SORT(.fini_array.*)))
        KEEP(*(.fini_array*))
        PROVIDE_HIDDEN (__fini_array_end = .);
    } >FLASH

    _sidata = LOADADDR(.data);

    .data :
    {
        . = ALIGN(4);
        _sdata = .;
        *(.data)
        *(.data*)
        . = ALIGN(4);
        _edata = .;
    } >RAM_D1 AT> FLASH

    . = ALIGN(4);
    .bss :
    {
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
        PROVIDE ( end = . );
        PROVIDE ( _end = . );
        . = . + _Min_Heap_Size;
        . = . + _Min_Stack_Size;
        . = ALIGN(8);
    } >DTCMRAM

    /DISCARD/ : { libc.a ( * ) libm.a ( * ) libgcc.a ( * ) }

    .ARM.attributes 0 : { *(.ARM.attributes) }
}
