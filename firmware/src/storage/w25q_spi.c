/**
 * Hardware transport for the W25Q: SPI1 plus a software chip select.
 *
 * Self-contained on purpose. The bootloader links this file to read a staged
 * image, and it links almost nothing else — no gpio.c, no spi.c, no FreeRTOS —
 * so this owns its four pins and its peripheral outright rather than depending
 * on the application's board setup having run.
 *
 * Everything above it (w25q.c) runs against a fake part on the host; this is
 * the only piece that needs wires.
 */

#include "w25q_spi.h"

#include "bsp.h"

/** Long enough for a full sector read at the configured prescaler. */
#define W25Q_XFER_TIMEOUT_MS 1000

static SPI_HandleTypeDef s_spi;
static w25q_t s_flash;
static bool s_started;

/**
 * Chip select, with the settle the datasheet asks for.
 *
 * The part needs a minimum CS-high time between commands (tSHSL, tens of ns)
 * and setup either side of the edge. Back to back, two GPIO writes on a
 * 550 MHz core are a handful of nanoseconds apart, so without this the flash
 * never sees the boundary and reads the next command as a continuation of the
 * last one.
 *
 * The symptom was maddeningly specific: any single transaction was correct, and
 * any run of them was not. A 256-byte dump matched the source byte for byte
 * while a CRC over four consecutive 256-byte reads of the very same range came
 * back wrong — and wrong differently each time.
 */
static void cs_settle(void)
{
    for (volatile int i = 0; i < 200; i++) {
        __asm__ volatile("nop");
    }
}

static void spi_cs(void* ctx, bool assert)
{
    (void)ctx;
    if (!assert) {
        cs_settle(); /* let the last clock finish before releasing */
    }
    HAL_GPIO_WritePin(W25Q_CS_PORT, W25Q_CS_PIN, assert ? GPIO_PIN_RESET : GPIO_PIN_SET);
    cs_settle();
}

/**
 * Bytes per HAL call. See spi_xfer() — this bounds how long a single polled
 * transfer can be starved before its RX FIFO overruns.
 */
#define W25Q_XFER_CHUNK 16u

/**
 * One slice of a transaction, chip select already asserted by the caller.
 *
 * Split into small pieces on purpose. This is a polled driver in a task that
 * the 433 MHz receiver's GDO0 interrupt preempts constantly; if the CPU is away
 * while a long receive is in flight, the SPI keeps clocking and the surplus
 * falls out of the RX FIFO. Measured with the CC1101 receiver enabled versus
 * disabled, over the same 4 KB read: 6/8 correct against 14/14.
 *
 * Chunking is safe because SPI is synchronous and the master owns the clock —
 * stop clocking mid-command and the flash simply waits, chip select still low,
 * for as long as it takes. There is no timeout on its side. So the exposure
 * window shrinks to one chunk instead of a whole 256-byte page, at the cost of
 * a few more HAL calls.
 */
static void spi_xfer(void* ctx, const uint8_t* tx, uint8_t* rx, size_t len)
{
    (void)ctx;

    while (len > 0) {
        uint16_t n = (uint16_t)(len > W25Q_XFER_CHUNK ? W25Q_XFER_CHUNK : len);

        if (tx != NULL && rx != NULL) {
            HAL_SPI_TransmitReceive(&s_spi, (uint8_t*)tx, rx, n, W25Q_XFER_TIMEOUT_MS);
        }
        else if (tx != NULL) {
            HAL_SPI_Transmit(&s_spi, (uint8_t*)tx, n, W25Q_XFER_TIMEOUT_MS);
        }
        else {
            /* Receive-only still clocks something out on MOSI; a NOR flash
               ignores it during a read data phase. */
            HAL_SPI_Receive(&s_spi, rx, n, W25Q_XFER_TIMEOUT_MS);
        }

        if (tx != NULL) {
            tx += n;
        }
        if (rx != NULL) {
            rx += n;
        }
        len -= n;
    }
}

/**
 * Pins, clock and peripheral.
 *
 * Getting this link reliable took four separate changes, and the order they
 * were found in is worth recording because each one looked like the answer:
 *
 *   1. Clock rate. At /32 every short transaction was correct and every long
 *      one was not — a 4 KB read came back wrong, and wrong differently each
 *      time (4BE683CC, then 29C4C488, for the same bytes). Slowing down helped.
 *   2. CS settle. Without a gap between commands the part never sees the
 *      boundary; see cs_settle().
 *   3. Decoupling. Adding a cap at the package took a 4 KB read from failing
 *      every time to failing about one time in ten.
 *   4. Transfer chunking, which was the one that finished it. See spi_xfer():
 *      the residual failures tracked the CC1101 receiver's interrupt load,
 *      not the radio's emissions.
 *
 * AUTOSUSP alone changed nothing, and that was briefly taken as ruling out FIFO
 * overrun. It did not — (4) is an overrun fix and it is what worked. AUTOSUSP
 * only suspends the clock once the FIFO is already full, which is too late when
 * the CPU is away for longer than the FIFO is deep.
 *
 * The remaining limit is the harness: four unshielded flying leads, no ground
 * plane. A soldered board would take many megahertz. Raise the rate only with a
 * long read CRCed repeatedly *while both radios are running* as the acceptance
 * test — a short transfer on a quiet board proves nothing, which is exactly how
 * this hid for so long.
 */
static void spi_hw_init(void)
{
    /* Give SPI1 a kernel clock that exists in both images.
     *
     * Its reset default source is PLL1Q, which the application starts in
     * bsp_clock_init() and the bootloader never does — the bootloader runs
     * HAL_Init() and nothing else, deliberately, because it hands the clock
     * tree over to the application untouched. So the same code that worked in
     * the application found no clock at all in the bootloader: transfers never
     * completed, the probe failed, and the staged image was reported missing.
     *
     * The board did the right thing with that (booted the installed
     * application, which is what a flash that does not answer must mean) so
     * the symptom was an update that silently did not happen.
     *
     * CKPER/HSI is running out of reset in both, so point SPI1 at it and the
     * two images behave identically. */
    RCC_PeriphCLKInitTypeDef pclk = {0};
    pclk.PeriphClockSelection = RCC_PERIPHCLK_SPI1 | RCC_PERIPHCLK_CKPER;
    pclk.CkperClockSelection = RCC_CLKPSOURCE_HSI;
    pclk.Spi123ClockSelection = RCC_SPI123CLKSOURCE_CLKP;
    (void)HAL_RCCEx_PeriphCLKConfig(&pclk);

    __HAL_RCC_GPIOA_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();
    __HAL_RCC_GPIOD_CLK_ENABLE();
    __HAL_RCC_SPI1_CLK_ENABLE();

    GPIO_InitTypeDef gpio = {0};
    gpio.Mode = GPIO_MODE_AF_PP;
    gpio.Pull = GPIO_NOPULL;
    gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    gpio.Alternate = W25Q_SPI_AF;

    gpio.Pin = W25Q_SCK_PIN;
    HAL_GPIO_Init(W25Q_SCK_PORT, &gpio);
    gpio.Pin = W25Q_MISO_PIN;
    HAL_GPIO_Init(W25Q_MISO_PORT, &gpio);
    gpio.Pin = W25Q_MOSI_PIN;
    HAL_GPIO_Init(W25Q_MOSI_PORT, &gpio);

    /* Drive CS high before it becomes an output, so the part never sees a
       spurious select while the pin settles. */
    HAL_GPIO_WritePin(W25Q_CS_PORT, W25Q_CS_PIN, GPIO_PIN_SET);
    gpio.Pin = W25Q_CS_PIN;
    gpio.Mode = GPIO_MODE_OUTPUT_PP;
    gpio.Speed = GPIO_SPEED_FREQ_HIGH;
    HAL_GPIO_Init(W25Q_CS_PORT, &gpio);

    s_spi.Instance = W25Q_SPI;
    s_spi.Init.Mode = SPI_MODE_MASTER;
    s_spi.Init.Direction = SPI_DIRECTION_2LINES;
    s_spi.Init.DataSize = SPI_DATASIZE_8BIT;
    s_spi.Init.CLKPolarity = SPI_POLARITY_LOW; /* mode 0 */
    s_spi.Init.CLKPhase = SPI_PHASE_1EDGE;
    s_spi.Init.NSS = SPI_NSS_SOFT;
    /* HSI is 64 MHz, so /64 is 1 MHz — a shade faster than the ~780 kHz the
     * PLL1Q-sourced /256 gave, and now identical in both images. */
    s_spi.Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_64;
    s_spi.Init.FirstBit = SPI_FIRSTBIT_MSB;
    s_spi.Init.TIMode = SPI_TIMODE_DISABLE;
    s_spi.Init.CRCCalculation = SPI_CRCCALCULATION_DISABLE;
    s_spi.Init.NSSPMode = SPI_NSS_PULSE_DISABLE;
    s_spi.Init.MasterKeepIOState = SPI_MASTER_KEEP_IO_STATE_ENABLE;
    s_spi.Init.FifoThreshold = SPI_FIFO_THRESHOLD_01DATA;

    /* Belt and braces, not the fix. An H7 master clocks a receive continuously
     * once started, and a polled driver that gets preempted can overrun its RX
     * FIFO; AUTOSUSP suspends the clock when the FIFO fills. Enabling it alone
     * changed nothing here — see the prescaler above for what actually did. */
    s_spi.Init.MasterReceiverAutoSusp = SPI_MASTER_RX_AUTOSUSP_ENABLE;

    (void)HAL_SPI_Init(&s_spi);
}

w25q_t* w25q_device(void)
{
    return &s_flash;
}

w25q_status_t w25q_spi_start(void)
{
    if (!s_started) {
        spi_hw_init();
        s_started = true;
    }

    w25q_io_t io;
    io.xfer = spi_xfer;
    io.cs = spi_cs;
    io.ctx = NULL;

    w25q_init(&s_flash, &io);
    return w25q_probe(&s_flash);
}

bool w25q_ready(void)
{
    return s_started && w25q_capacity(&s_flash) > 0;
}
