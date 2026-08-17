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

static void spi_xfer(void* ctx, const uint8_t* tx, uint8_t* rx, size_t len)
{
    (void)ctx;
    if (len == 0) {
        return;
    }

    if (tx != NULL && rx != NULL) {
        HAL_SPI_TransmitReceive(&s_spi, (uint8_t*)tx, rx, (uint16_t)len, W25Q_XFER_TIMEOUT_MS);
        return;
    }
    if (tx != NULL) {
        HAL_SPI_Transmit(&s_spi, (uint8_t*)tx, (uint16_t)len, W25Q_XFER_TIMEOUT_MS);
        return;
    }
    /* Receive-only still clocks something out on MOSI; a NOR flash ignores it
       during a read data phase. */
    HAL_SPI_Receive(&s_spi, rx, (uint16_t)len, W25Q_XFER_TIMEOUT_MS);
}

/**
 * Pins and peripheral.
 *
 * On the prescaler, because it is the interesting part and it was measured
 * rather than chosen:
 *
 * At /32 the link passed everything short and failed everything long. A probe,
 * a status read, a 64-byte dump and a 512-byte program-and-verify were all
 * fine; a 4 KB read came back wrong, and wrong *differently each time* —
 * 4BE683CC then 29C4C488 for the same bytes. Staging a 320 KB image failed its
 * CRC every attempt while every chunk was acknowledged.
 *
 * Enabling AUTOSUSP did not help, which ruled out FIFO overrun. Dropping to
 * /256 made the same 4 KB read repeatable and correct on the first try.
 *
 * So the limit is the harness, not the design: this part is on four unshielded
 * flying leads with no ground plane and no local decoupling. A soldered board
 * would take many megahertz. Raise this only with a long read CRCed twice as
 * the acceptance test — a short transfer proves nothing, which is exactly how
 * this hid in the first place.
 */
static void spi_hw_init(void)
{
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
    s_spi.Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_256;
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
