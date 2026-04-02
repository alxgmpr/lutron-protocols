#ifndef THREAD_CONFIG_H
#define THREAD_CONFIG_H

/**
 * Thread network parameters — copy to thread_config.h and fill in your values.
 * Get these from the LEAP API: /link endpoint on your processor.
 */

#define LUTRON_THREAD_CHANNEL 25
#define LUTRON_THREAD_PANID 0x0000

static const uint8_t LUTRON_THREAD_XPANID[8] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};

static const uint8_t LUTRON_THREAD_MASTER_KEY[16] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                                     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};

#endif /* THREAD_CONFIG_H */
