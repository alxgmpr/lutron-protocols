/* BSP for STM32L100CB — bare-metal register definitions */
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

/* ---- Cortex-M3 core registers ---- */
#define SCB_BASE         0xE000ED00UL
#define SCB_DHCSR        (*(volatile uint32_t*)(0xE000EDF0UL))
#define NVIC_ISER(n)     (*(volatile uint32_t*)(0xE000E100UL + 4*(n)))
#define SYSTICK_CTRL     (*(volatile uint32_t*)0xE000E010UL)
#define SYSTICK_LOAD     (*(volatile uint32_t*)0xE000E014UL)
#define SYSTICK_VAL      (*(volatile uint32_t*)0xE000E018UL)

/* ---- RCC ---- */
#define RCC_BASE         0x40023800UL
#define RCC_CR           (*(volatile uint32_t*)(RCC_BASE + 0x00))
#define RCC_CFGR         (*(volatile uint32_t*)(RCC_BASE + 0x0C))
#define RCC_AHBENR       (*(volatile uint32_t*)(RCC_BASE + 0x1C))
#define RCC_APB2ENR      (*(volatile uint32_t*)(RCC_BASE + 0x20))
#define RCC_APB1ENR      (*(volatile uint32_t*)(RCC_BASE + 0x24))

/* RCC_CR bits */
#define RCC_CR_HSION     (1 << 0)
#define RCC_CR_HSIRDY    (1 << 1)
#define RCC_CR_PLLON     (1 << 24)
#define RCC_CR_PLLRDY    (1 << 25)

/* RCC_CFGR bits */
#define RCC_CFGR_SW_PLL  (3 << 0)
#define RCC_CFGR_SWS_PLL (3 << 2)
#define RCC_CFGR_PLLSRC_HSI (0 << 16)
#define RCC_CFGR_PLLMUL4 (1 << 18)  /* HSI/2 * 4 = 32 MHz */
#define RCC_CFGR_PLLDIV2 (1 << 22)  /* /2 */

/* AHB enable bits */
#define RCC_AHBENR_GPIOAEN (1 << 0)
#define RCC_AHBENR_GPIOBEN (1 << 1)

/* APB2 enable bits */
#define RCC_APB2ENR_USART1EN (1 << 14)

/* APB1 enable bits */
#define RCC_APB1ENR_USART2EN (1 << 14)
#define RCC_APB1ENR_PWREN    (1 << 28)

/* ---- GPIO ---- */
#define GPIOA_BASE       0x40020000UL
#define GPIOB_BASE       0x40020400UL

typedef struct {
    volatile uint32_t MODER;
    volatile uint32_t OTYPER;
    volatile uint32_t OSPEEDR;
    volatile uint32_t PUPDR;
    volatile uint32_t IDR;
    volatile uint32_t ODR;
    volatile uint32_t BSRR;
    volatile uint32_t LCKR;
    volatile uint32_t AFR[2]; /* AFRL [0], AFRH [1] */
} GPIO_TypeDef;

#define GPIOA ((GPIO_TypeDef*)GPIOA_BASE)
#define GPIOB ((GPIO_TypeDef*)GPIOB_BASE)

/* GPIO MODER: 00=input, 01=output, 10=AF, 11=analog */
#define GPIO_MODER_AF    2
#define GPIO_MODER_OUT   1

/* ---- USART ---- */
#define USART1_BASE      0x40013800UL
#define USART2_BASE      0x40004400UL

typedef struct {
    volatile uint32_t SR;
    volatile uint32_t DR;
    volatile uint32_t BRR;
    volatile uint32_t CR1;
    volatile uint32_t CR2;
    volatile uint32_t CR3;
    volatile uint32_t GTPR;
} USART_TypeDef;

#define USART1 ((USART_TypeDef*)USART1_BASE)
#define USART2 ((USART_TypeDef*)USART2_BASE)

/* USART_SR bits */
#define USART_SR_RXNE  (1 << 5)
#define USART_SR_TXE   (1 << 7)
#define USART_SR_TC    (1 << 6)

/* USART_CR1 bits */
#define USART_CR1_UE    (1 << 13)
#define USART_CR1_TE    (1 << 3)
#define USART_CR1_RE    (1 << 2)
#define USART_CR1_RXNEIE (1 << 5)

/* ---- Pin assignments ---- */
/* USART1: PA9=TX(AF7), PA10=RX(AF7) — HDLC to AM335x */
#define HDLC_TX_PIN  9
#define HDLC_RX_PIN  10
#define HDLC_AF      7

/* ---- Ring buffer ---- */
#define RING_SIZE 512

typedef struct {
    volatile uint8_t buf[RING_SIZE];
    volatile uint16_t head;
    volatile uint16_t tail;
} ringbuf_t;

static inline void ring_init(ringbuf_t* r) { r->head = r->tail = 0; }

static inline bool ring_put(ringbuf_t* r, uint8_t b) {
    uint16_t next = (r->head + 1) % RING_SIZE;
    if (next == r->tail) return false; /* full */
    r->buf[r->head] = b;
    r->head = next;
    return true;
}

static inline bool ring_get(ringbuf_t* r, uint8_t* b) {
    if (r->head == r->tail) return false; /* empty */
    *b = r->buf[r->tail];
    r->tail = (r->tail + 1) % RING_SIZE;
    return true;
}

static inline uint16_t ring_count(ringbuf_t* r) {
    return (r->head - r->tail + RING_SIZE) % RING_SIZE;
}

/* ---- Globals ---- */
extern volatile uint32_t sys_tick_ms;
extern ringbuf_t usart1_rx_ring;

/* ---- Functions ---- */
void clock_init(void);
void usart1_init(void);
void usart1_tx_byte(uint8_t b);
void usart1_tx_buf(const uint8_t* data, size_t len);

/* Semihosting */
void sh_puts(const char* s);
void sh_puthex(const uint8_t* data, size_t len);
void sh_printf(const char* fmt, ...);
