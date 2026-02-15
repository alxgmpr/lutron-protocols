#ifndef ETH_H
#define ETH_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Initialize Ethernet MAC, PHY (LAN8742A), and lwIP stack */
void bsp_eth_init(void);

/** Get current IP address as string (returns "0.0.0.0" if no link) */
const char *eth_get_ip_str(void);

/** Check if Ethernet link is up */
bool eth_link_is_up(void);

/** Poll PHY link status — call periodically from a task */
void eth_poll_link(void);

/** Debug counters */
uint32_t eth_get_tx_ok(void);
uint32_t eth_get_tx_fail(void);
uint32_t eth_get_rx_frames(void);

#ifdef __cplusplus
}
#endif

#endif /* ETH_H */
