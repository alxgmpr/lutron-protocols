/**
 * CCA TDMA hardware timer — TIM2 free-running at 100 kHz.
 *
 * TIM2 is a 32-bit general-purpose timer on APB1.
 * APB1 timer clock = 275 MHz (STM32H723 with APB1 prescaler ≠ 1 → doubled).
 * Prescaler 2750 → 100 kHz tick rate → 10 µs per tick.
 *
 * Channel 1 compare used for one-shot scheduled callbacks.
 */

#include "cca_timer.h"
#include "stm32h7xx_hal.h"

/* TIM2 prescaler: 275 MHz / 2750 = 100 kHz */
#define TIM2_PRESCALER  (2750 - 1)

static volatile cca_timer_callback_t pending_callback_ = NULL;

void cca_timer_init(void)
{
    /* Enable TIM2 clock */
    __HAL_RCC_TIM2_CLK_ENABLE();

    /* Reset and configure */
    TIM2->CR1 = 0;
    TIM2->PSC = TIM2_PRESCALER;
    TIM2->ARR = 0xFFFFFFFF;  /* 32-bit free-running */
    TIM2->CNT = 0;

    /* Channel 1: output compare, no output pin, interrupt on match */
    TIM2->CCMR1 = 0;  /* frozen mode — no output, just compare */
    TIM2->CCER = 0;   /* no capture/compare output */
    TIM2->DIER = 0;   /* no interrupts yet (enabled when scheduled) */

    /* Generate update event to load prescaler, then start */
    TIM2->EGR = TIM_EGR_UG;
    TIM2->SR = 0;  /* clear update flag */
    TIM2->CR1 = TIM_CR1_CEN;  /* start counting */

    /* Enable TIM2 IRQ in NVIC (for compare channel callbacks) */
    HAL_NVIC_SetPriority(TIM2_IRQn, 5, 0);  /* same priority as CCA task */
    HAL_NVIC_EnableIRQ(TIM2_IRQn);
}

uint32_t cca_timer_ticks(void)
{
    return TIM2->CNT;
}

void cca_timer_wait_until(uint32_t target_tick)
{
    while ((int32_t)(target_tick - TIM2->CNT) > 0) {
        /* tight spin */
    }
}

void cca_timer_schedule(uint32_t fire_tick, cca_timer_callback_t callback)
{
    /* Disable channel 1 interrupt while configuring */
    TIM2->DIER &= ~TIM_DIER_CC1IE;
    TIM2->SR &= ~TIM_SR_CC1IF;

    pending_callback_ = callback;
    TIM2->CCR1 = fire_tick;

    /* Enable channel 1 compare interrupt */
    TIM2->DIER |= TIM_DIER_CC1IE;
}

void cca_timer_cancel(void)
{
    TIM2->DIER &= ~TIM_DIER_CC1IE;
    TIM2->SR &= ~TIM_SR_CC1IF;
    pending_callback_ = NULL;
}

/**
 * TIM2 IRQ handler — fires when compare channel matches.
 * Calls the pending callback and disables the interrupt.
 */
void TIM2_IRQHandler(void)
{
    if (TIM2->SR & TIM_SR_CC1IF) {
        TIM2->SR = ~TIM_SR_CC1IF;  /* clear flag */
        TIM2->DIER &= ~TIM_DIER_CC1IE;  /* one-shot: disable after firing */

        cca_timer_callback_t cb = pending_callback_;
        pending_callback_ = NULL;
        if (cb) cb();
    }
}
