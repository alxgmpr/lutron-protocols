/* STM32L100CB HDLC Sniffer — Phase 1: Log all HDLC traffic from AM335x
 *
 * Captures HDLC frames from lutron-core on USART1 (PA9/PA10) and dumps
 * them via ARM semihosting (SWD debug output — no extra wires needed).
 *
 * HDLC frame format: [0x7E] [escaped payload + CRC16] [0x7E]
 * CLAP layer inside: [addr] [ctrl] [cmd_hi] [cmd_lo] [data...]
 */
#include "bsp.h"
#include "hdlc.h"

/* ---- SysTick ---- */
volatile uint32_t sys_tick_ms = 0;

void SysTick_Handler(void) {
    sys_tick_ms++;
}

/* ---- USART1 RX interrupt ---- */
ringbuf_t usart1_rx_ring;

void USART1_IRQHandler(void) {
    if (USART1->SR & USART_SR_RXNE) {
        uint8_t b = (uint8_t)USART1->DR;
        ring_put(&usart1_rx_ring, b);
    }
}

/* ---- Clock: HSI 16MHz → 32MHz via PLL ---- */
void clock_init(void) {
    /* Enable HSI */
    RCC_CR |= RCC_CR_HSION;
    while (!(RCC_CR & RCC_CR_HSIRDY));

    /* Enable power controller for voltage range config */
    RCC_APB1ENR |= RCC_APB1ENR_PWREN;

    /* Configure PLL: HSI (16MHz) / 2 * 4 = 32MHz
     * STM32L1 PLL: input = HSI/2 = 8MHz, PLLMUL=4 → 32MHz, PLLDIV=2 → 16MHz...
     * Actually STM32L1 PLL is: PLLCLK = (HSI or HSE) * PLLMUL / PLLDIV
     * For 32MHz from HSI: PLLMUL=4, PLLDIV=2 → 16*4/2 = 32MHz */
    RCC_CFGR = RCC_CFGR_PLLSRC_HSI | RCC_CFGR_PLLMUL4 | RCC_CFGR_PLLDIV2;

    /* Enable PLL */
    RCC_CR |= RCC_CR_PLLON;
    while (!(RCC_CR & RCC_CR_PLLRDY));

    /* Switch system clock to PLL */
    RCC_CFGR = (RCC_CFGR & ~3) | RCC_CFGR_SW_PLL;
    while ((RCC_CFGR & RCC_CFGR_SWS_PLL) != RCC_CFGR_SWS_PLL);

    /* SysTick: 1ms tick at 32MHz */
    SYSTICK_LOAD = 32000 - 1;
    SYSTICK_VAL = 0;
    SYSTICK_CTRL = 7; /* enable, interrupt, use processor clock */
}

/* ---- USART1: HDLC link to AM335x @ 115200 ---- */
void usart1_init(void) {
    /* Enable GPIOA and USART1 clocks */
    RCC_AHBENR |= RCC_AHBENR_GPIOAEN;
    RCC_APB2ENR |= RCC_APB2ENR_USART1EN;

    /* PA9 = USART1_TX (AF7), PA10 = USART1_RX (AF7) */
    /* MODER: alternate function (10) for pins 9 and 10 */
    GPIOA->MODER &= ~((3 << (HDLC_TX_PIN * 2)) | (3 << (HDLC_RX_PIN * 2)));
    GPIOA->MODER |= (GPIO_MODER_AF << (HDLC_TX_PIN * 2)) | (GPIO_MODER_AF << (HDLC_RX_PIN * 2));

    /* High speed for TX */
    GPIOA->OSPEEDR |= (3 << (HDLC_TX_PIN * 2));

    /* AF7 for USART1: AFRH (pins 8-15) */
    GPIOA->AFR[1] &= ~((0xF << ((HDLC_TX_PIN - 8) * 4)) | (0xF << ((HDLC_RX_PIN - 8) * 4)));
    GPIOA->AFR[1] |= (HDLC_AF << ((HDLC_TX_PIN - 8) * 4)) | (HDLC_AF << ((HDLC_RX_PIN - 8) * 4));

    /* 115200 baud @ 32MHz: BRR = 32000000 / 115200 ≈ 278 */
    USART1->BRR = 278;
    USART1->CR1 = USART_CR1_UE | USART_CR1_TE | USART_CR1_RE | USART_CR1_RXNEIE;

    /* Enable USART1 interrupt in NVIC (IRQ 37) */
    NVIC_ISER(1) = (1 << (37 - 32));

    ring_init(&usart1_rx_ring);
}

void usart1_tx_byte(uint8_t b) {
    while (!(USART1->SR & USART_SR_TXE));
    USART1->DR = b;
}

void usart1_tx_buf(const uint8_t* data, size_t len) {
    for (size_t i = 0; i < len; i++)
        usart1_tx_byte(data[i]);
}

/* ---- Main ---- */
int main(void) {
    clock_init();
    usart1_init();

    sh_puts("\n=== STM32L100 HDLC Sniffer v0.1 ===\n");
    sh_puts("Listening on USART1 (PA9/PA10) @ 115200\n");
    sh_puts("Waiting for HDLC frames from AM335x...\n\n");

    hdlc_state_t hdlc;
    hdlc_init(&hdlc);

    uint32_t frame_count = 0;
    uint32_t last_activity = 0;

    while (1) {
        uint8_t byte;
        while (ring_get(&usart1_rx_ring, &byte)) {
            last_activity = sys_tick_ms;
            int result = hdlc_feed(&hdlc, byte);

            if (result > 0) {
                /* Complete frame received */
                frame_count++;
                sh_printf("[%08lu] RX frame #%lu (%d bytes): ",
                         sys_tick_ms, frame_count, result);
                sh_puthex(hdlc.frame, result);

                /* Decode HDLC control field */
                if (result >= 2) {
                    uint8_t addr = hdlc.frame[0];
                    uint8_t ctrl = hdlc.frame[1];
                    hdlc_decode_ctrl(addr, ctrl, hdlc.frame + 2, result - 2);
                }
                sh_puts("\n");
            } else if (result == -1) {
                sh_puts("[CRC ERROR]\n");
            }
        }

        /* Periodic idle message */
        if (sys_tick_ms - last_activity > 5000 && last_activity > 0) {
            sh_printf("[%08lu] idle (%u bytes in ring)\n",
                     sys_tick_ms, ring_count(&usart1_rx_ring));
            last_activity = sys_tick_ms;
        }
    }
}
