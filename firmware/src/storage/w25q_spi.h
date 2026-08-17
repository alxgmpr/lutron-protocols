#ifndef W25Q_SPI_H
#define W25Q_SPI_H

/**
 * The W25Q bound to SPI1 on CN7. See bsp.h for the pin assignment and w25q.h
 * for the driver itself.
 */

#include "w25q.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Bring SPI1 up (once) and probe the part. Safe to call repeatedly. */
w25q_status_t w25q_spi_start(void);

/** The bound device, for callers that already know it probed. */
w25q_t* w25q_device(void);

/** True once SPI1 is up and a plausible part answered. */
bool w25q_ready(void);

#ifdef __cplusplus
}
#endif

#endif /* W25Q_SPI_H */
