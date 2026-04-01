/* Startup for STM32L100CB (Cortex-M3) — minimal vector table + Reset_Handler */
.syntax unified
.cpu cortex-m3
.thumb

.global g_pfnVectors
.global Reset_Handler

.section .isr_vector,"a",%progbits
.type g_pfnVectors, %object
g_pfnVectors:
    .word _estack               /* 0x00: Initial SP */
    .word Reset_Handler         /* 0x04: Reset */
    .word NMI_Handler           /* 0x08 */
    .word HardFault_Handler     /* 0x0C */
    .word MemManage_Handler     /* 0x10 */
    .word BusFault_Handler      /* 0x14 */
    .word UsageFault_Handler    /* 0x18 */
    .word 0                     /* 0x1C: Reserved */
    .word 0                     /* 0x20 */
    .word 0                     /* 0x24 */
    .word 0                     /* 0x28 */
    .word SVC_Handler           /* 0x2C */
    .word 0                     /* 0x30 */
    .word 0                     /* 0x34 */
    .word PendSV_Handler        /* 0x38 */
    .word SysTick_Handler       /* 0x3C */
    /* External interrupts (IRQ 0-56 for STM32L1) */
    .word 0                     /* 0: WWDG */
    .word 0                     /* 1: PVD */
    .word 0                     /* 2: TAMPER_STAMP */
    .word 0                     /* 3: RTC_WKUP */
    .word 0                     /* 4: FLASH */
    .word 0                     /* 5: RCC */
    .word 0                     /* 6: EXTI0 */
    .word 0                     /* 7: EXTI1 */
    .word 0                     /* 8: EXTI2 */
    .word 0                     /* 9: EXTI3 */
    .word 0                     /* 10: EXTI4 */
    .word 0                     /* 11: DMA1_Ch1 */
    .word 0                     /* 12: DMA1_Ch2 */
    .word 0                     /* 13: DMA1_Ch3 */
    .word 0                     /* 14: DMA1_Ch4 */
    .word 0                     /* 15: DMA1_Ch5 */
    .word 0                     /* 16: DMA1_Ch6 */
    .word 0                     /* 17: DMA1_Ch7 */
    .word 0                     /* 18: ADC1 */
    .word 0                     /* 19: USB_HP */
    .word 0                     /* 20: USB_LP */
    .word 0                     /* 21: DAC */
    .word 0                     /* 22: COMP_CA */
    .word 0                     /* 23: EXTI9_5 */
    .word 0                     /* 24: LCD */
    .word 0                     /* 25: TIM9 */
    .word 0                     /* 26: TIM10 */
    .word 0                     /* 27: TIM11 */
    .word 0                     /* 28: TIM2 */
    .word 0                     /* 29: TIM3 */
    .word 0                     /* 30: TIM4 */
    .word 0                     /* 31: I2C1_EV */
    .word 0                     /* 32: I2C1_ER */
    .word 0                     /* 33: I2C2_EV */
    .word 0                     /* 34: I2C2_ER */
    .word 0                     /* 35: SPI1 */
    .word 0                     /* 36: SPI2 */
    .word USART1_IRQHandler     /* 37: USART1 */
    .word 0                     /* 38: USART2 */
    .word 0                     /* 39: USART3 */
    .word 0                     /* 40: EXTI15_10 */
    .word 0                     /* 41: RTC_Alarm */
    .word 0                     /* 42: USB_FS_WKUP */
    .word 0                     /* 43: TIM6 */
    .word 0                     /* 44: TIM7 */
.size g_pfnVectors, .-g_pfnVectors

.section .text.Reset_Handler
.weak Reset_Handler
.type Reset_Handler, %function
Reset_Handler:
    /* Set stack pointer */
    ldr r0, =_estack
    mov sp, r0

    /* Copy .data from flash to SRAM */
    ldr r0, =_sdata
    ldr r1, =_edata
    ldr r2, =_sidata
    movs r3, #0
    b .Ldata_loop_check
.Ldata_copy:
    ldr r4, [r2, r3]
    str r4, [r0, r3]
    adds r3, r3, #4
.Ldata_loop_check:
    adds r4, r0, r3
    cmp r4, r1
    bcc .Ldata_copy

    /* Zero .bss */
    ldr r2, =_sbss
    ldr r4, =_ebss
    movs r3, #0
    b .Lbss_loop_check
.Lbss_fill:
    str r3, [r2]
    adds r2, r2, #4
.Lbss_loop_check:
    cmp r2, r4
    bcc .Lbss_fill

    /* Call main */
    bl main
    b .
.size Reset_Handler, .-Reset_Handler

/* Default handlers — infinite loop */
.section .text.Default_Handler,"ax",%progbits
Default_Handler:
    b .
.size Default_Handler, .-Default_Handler

.weak NMI_Handler
.thumb_set NMI_Handler, Default_Handler
.weak HardFault_Handler
.thumb_set HardFault_Handler, Default_Handler
.weak MemManage_Handler
.thumb_set MemManage_Handler, Default_Handler
.weak BusFault_Handler
.thumb_set BusFault_Handler, Default_Handler
.weak UsageFault_Handler
.thumb_set UsageFault_Handler, Default_Handler
.weak SVC_Handler
.thumb_set SVC_Handler, Default_Handler
.weak PendSV_Handler
.thumb_set PendSV_Handler, Default_Handler
.weak SysTick_Handler
.thumb_set SysTick_Handler, Default_Handler
.weak USART1_IRQHandler
.thumb_set USART1_IRQHandler, Default_Handler
