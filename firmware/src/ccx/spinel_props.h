#ifndef SPINEL_PROPS_H
#define SPINEL_PROPS_H

/**
 * Spinel property IDs and Thread network constants for nRF52840 NCP.
 *
 * Property IDs match OpenThread spinel.h (ot-nrf528xx/openthread/src/lib/spinel/spinel.h).
 * All property IDs used here are <= 0x72, so they fit in a single-byte
 * Spinel VUI encoding (no multi-byte needed).
 */

#include <stdint.h>

/* -----------------------------------------------------------------------
 * Spinel commands
 * ----------------------------------------------------------------------- */
#define SPINEL_CMD_NOOP          0x00
#define SPINEL_CMD_RESET         0x01
#define SPINEL_CMD_PROP_GET      0x02
#define SPINEL_CMD_PROP_SET      0x03
#define SPINEL_CMD_PROP_INSERT   0x04
#define SPINEL_CMD_PROP_REMOVE   0x05
#define SPINEL_CMD_PROP_IS       0x06 /* Response to GET/SET */
#define SPINEL_CMD_PROP_INSERTED 0x07 /* Unsolicited (e.g. STREAM_NET RX) */

/* -----------------------------------------------------------------------
 * Spinel property IDs — core
 *
 * Values from OpenThread: SPINEL_PROP_BASE__BEGIN = 0x00
 * ----------------------------------------------------------------------- */
#define SPINEL_PROP_PROTOCOL_VERSION 0x01
#define SPINEL_PROP_NCP_VERSION      0x02
#define SPINEL_PROP_HWADDR           0x08 /* EUI-64 */

/* -----------------------------------------------------------------------
 * Spinel property IDs — PHY layer (SPINEL_PROP_PHY__BEGIN = 0x20)
 * ----------------------------------------------------------------------- */
#define SPINEL_PROP_PHY_CHAN          0x21 /* [C] uint8_t channel */
#define SPINEL_PROP_PHY_CCA_THRESHOLD 0x24 /* [c] int8_t CCA threshold (dBm) */

/* -----------------------------------------------------------------------
 * Spinel property IDs — MAC layer (SPINEL_PROP_MAC__BEGIN = 0x30)
 * ----------------------------------------------------------------------- */
#define SPINEL_PROP_MAC_15_4_LADDR         0x34 /* [E] EUI-64 (read-only on NCP) */
#define SPINEL_PROP_MAC_15_4_SADDR         0x35 /* [S] uint16_t short address */
#define SPINEL_PROP_MAC_15_4_PANID         0x36 /* [S] uint16_t PAN ID (LE) */
#define SPINEL_PROP_MAC_RAW_STREAM_ENABLED 0x37 /* [b] bool: enable raw frame delivery */
#define SPINEL_PROP_MAC_PROMISCUOUS_MODE   0x38 /* [C] uint8_t: promiscuous mode */

/* Promiscuous mode values */
#define SPINEL_MAC_PROMISCUOUS_MODE_OFF     0
#define SPINEL_MAC_PROMISCUOUS_MODE_NETWORK 1 /* All frames on this PAN */
#define SPINEL_MAC_PROMISCUOUS_MODE_FULL    2 /* All frames on channel */

/* -----------------------------------------------------------------------
 * Spinel property IDs — NET layer (SPINEL_PROP_NET__BEGIN = 0x40)
 * ----------------------------------------------------------------------- */
#define SPINEL_PROP_NET_IF_UP        0x41 /* [b] bool: interface up */
#define SPINEL_PROP_NET_STACK_UP     0x42 /* [b] bool: Thread stack up */
#define SPINEL_PROP_NET_ROLE         0x43 /* [C] uint8_t: role */
#define SPINEL_PROP_NET_NETWORK_NAME 0x44 /* [U] UTF-8 network name */
#define SPINEL_PROP_NET_XPANID       0x45 /* [D] 8-byte extended PAN ID */
#define SPINEL_PROP_NET_NETWORK_KEY  0x46 /* [D] 16-byte master key */

/* -----------------------------------------------------------------------
 * Spinel property IDs — IPv6 (SPINEL_PROP_IPV6__BEGIN = 0x60)
 * ----------------------------------------------------------------------- */
#define SPINEL_PROP_IPV6_ADDRESS_TABLE           0x63 /* [A(t(6CLLC))] IPv6 addresses */
#define SPINEL_PROP_IPV6_MULTICAST_ADDRESS_TABLE 0x66 /* [A(t(6))] multicast addresses */

/* -----------------------------------------------------------------------
 * Spinel property IDs — Stream (SPINEL_PROP_STREAM__BEGIN = 0x70)
 * ----------------------------------------------------------------------- */
#define SPINEL_PROP_STREAM_RAW 0x71 /* [dD] Raw 802.15.4 frame RX (promiscuous) */
#define SPINEL_PROP_STREAM_NET 0x72 /* [dD] IPv6 packet TX/RX */

/* -----------------------------------------------------------------------
 * Thread net role values
 * ----------------------------------------------------------------------- */
#define SPINEL_NET_ROLE_DETACHED 0
#define SPINEL_NET_ROLE_CHILD    1
#define SPINEL_NET_ROLE_ROUTER   2
#define SPINEL_NET_ROLE_LEADER   3

/* -----------------------------------------------------------------------
 * Lutron Thread network parameters (from thread_config.h)
 * Copy thread_config.example.h -> thread_config.h and fill in your values.
 * ----------------------------------------------------------------------- */
#include "thread_config.h"

/* ff03::1 — Thread mesh-local multicast (all FTDs + MTDs) */
static const uint8_t CCX_MULTICAST_ADDR[16] = {0xFF, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                               0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01};

#endif /* SPINEL_PROPS_H */
