/**
 * Hardware transport for the W25Q: SPI1 plus a software chip select.
 *
 * The whole of w25q.c runs against a fake part on the host; this file is the
 * only piece that needs wires, which is why it holds nothing but the two
 * callbacks and a handle.
 */

#include "w25q_spi.h"

#include "bsp.h"

/** Long enough for a full 4 KB sector read at the configured prescaler. */
#define W25Q_XFER_TIMEOUT_MS 1000

static w25q_t s_flash;
static bool s_started;

static void spi_cs(void* ctx, bool assert)
{
    (void)ctx;
    HAL_GPIO_WritePin(W25Q_CS_PORT, W25Q_CS_PIN, assert ? GPIO_PIN_RESET : GPIO_PIN_SET);
}

static void spi_xfer(void* ctx, const uint8_t* tx, uint8_t* rx, size_t len)
{
    (void)ctx;
    if (len == 0) {
        return;
    }

    if (tx != NULL && rx != NULL) {
        HAL_SPI_TransmitReceive(&hspi1, (uint8_t*)tx, rx, (uint16_t)len, W25Q_XFER_TIMEOUT_MS);
        return;
    }
    if (tx != NULL) {
        HAL_SPI_Transmit(&hspi1, (uint8_t*)tx, (uint16_t)len, W25Q_XFER_TIMEOUT_MS);
        return;
    }
    /* Receive-only still has to clock something out. HAL_SPI_Receive drives
       whatever happens to be in the TX register on this part, which is fine
       for a NOR flash — it ignores MOSI during a read data phase. */
    HAL_SPI_Receive(&hspi1, rx, (uint16_t)len, W25Q_XFER_TIMEOUT_MS);
}

w25q_t* w25q_device(void)
{
    return &s_flash;
}

w25q_status_t w25q_spi_start(void)
{
    if (!s_started) {
        bsp_spi1_init();
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
