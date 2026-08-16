/**
 * GPIO bit-bang backend for SWD. See swd_gpio.h — this is the only piece of
 * the SWD stack with no test coverage, because it is the only piece that
 * needs wires.
 */

#include "swd_gpio.h"

#include "bsp.h"

/* Half a SWCLK period, in core cycles. SystemCoreClock is 550 MHz here, so a
   1 MHz clock is 275 cycles per half period. Computed at run time so the
   timing survives a clock tree change. */
static uint32_t half_period_cycles(void)
{
    uint32_t c = SystemCoreClock / (SWD_GPIO_CLK_HZ * 2u);
    return c < 1u ? 1u : c;
}

static uint32_t s_half_cycles = 1;

static inline void swd_delay(void)
{
    uint32_t start = DWT->CYCCNT;
    while ((DWT->CYCCNT - start) < s_half_cycles) {
        /* busy wait; DWT is enabled in bsp_clock_init() */
    }
}

static inline void clk_low(void)
{
    NRF_SWCLK_PORT->BSRR = (uint32_t)NRF_SWCLK_PIN << 16;
}

static inline void clk_high(void)
{
    NRF_SWCLK_PORT->BSRR = NRF_SWCLK_PIN;
}

static inline void dio_write(bool bit)
{
    NRF_SWDIO_PORT->BSRR = bit ? (uint32_t)NRF_SWDIO_PIN : ((uint32_t)NRF_SWDIO_PIN << 16);
}

static inline bool dio_read(void)
{
    return (NRF_SWDIO_PORT->IDR & NRF_SWDIO_PIN) != 0;
}

/* -----------------------------------------------------------------------
 * swd_io_t implementation
 * ----------------------------------------------------------------------- */

/** Host drives SWDIO: set it while the clock is low, target samples on rise. */
static void gpio_clock_out(void* ctx, bool bit)
{
    (void)ctx;
    dio_write(bit);
    clk_low();
    swd_delay();
    clk_high();
    swd_delay();
}

/** Target drives SWDIO: sample during the low phase, before the rising edge. */
static bool gpio_clock_in(void* ctx)
{
    (void)ctx;
    clk_low();
    swd_delay();
    bool bit = dio_read();
    clk_high();
    swd_delay();
    return bit;
}

/** MODER field shift for SWDIO, computed once in swd_gpio_init(). */
static uint32_t s_dio_moder_shift;

static void gpio_set_output(void* ctx, bool host_drives)
{
    (void)ctx;
    uint32_t moder = NRF_SWDIO_PORT->MODER;
    moder &= ~(3u << s_dio_moder_shift);
    /* 01 = general purpose output, 00 = input. */
    moder |= (host_drives ? 1u : 0u) << s_dio_moder_shift;
    NRF_SWDIO_PORT->MODER = moder;
}

/* -----------------------------------------------------------------------
 * Setup
 * ----------------------------------------------------------------------- */

void swd_gpio_init(void)
{
    __HAL_RCC_GPIOF_CLK_ENABLE();

    s_half_cycles = half_period_cycles();

    uint32_t pos = 0;
    for (uint32_t pin = NRF_SWDIO_PIN; (pin & 1u) == 0; pin >>= 1) {
        pos++;
    }
    s_dio_moder_shift = pos * 2u;

    GPIO_InitTypeDef g = {0};

    /* SWDIO: push-pull output to start; gpio_set_output() flips it to input
       for the turnaround and ACK phases. Pull-up so the line reads high when
       neither side drives, which is what makes a missing ACK show up as
       0b111 (SWD_ERR_NO_ACK) rather than as a plausible OK. */
    g.Pin = NRF_SWDIO_PIN;
    g.Mode = GPIO_MODE_OUTPUT_PP;
    g.Pull = GPIO_PULLUP;
    g.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    HAL_GPIO_Init(NRF_SWDIO_PORT, &g);

    g.Pin = NRF_SWCLK_PIN;
    g.Mode = GPIO_MODE_OUTPUT_PP;
    g.Pull = GPIO_NOPULL;
    HAL_GPIO_Init(NRF_SWCLK_PORT, &g);

    clk_low();
    dio_write(true);
}

void swd_gpio_deinit(void)
{
    GPIO_InitTypeDef g = {0};
    g.Mode = GPIO_MODE_INPUT;
    g.Pull = GPIO_NOPULL;
    g.Speed = GPIO_SPEED_FREQ_LOW;

    /* Separately, so the two lines are free to live on different ports. */
    g.Pin = NRF_SWDIO_PIN;
    HAL_GPIO_Init(NRF_SWDIO_PORT, &g);
    g.Pin = NRF_SWCLK_PIN;
    HAL_GPIO_Init(NRF_SWCLK_PORT, &g);
}

swd_io_t swd_gpio_io(void)
{
    swd_io_t io;
    io.clock_out = gpio_clock_out;
    io.clock_in = gpio_clock_in;
    io.set_output = gpio_set_output;
    io.ctx = 0;
    return io;
}
