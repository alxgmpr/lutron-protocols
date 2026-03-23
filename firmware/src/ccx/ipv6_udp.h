#ifndef IPV6_UDP_H
#define IPV6_UDP_H

/**
 * IPv6 + UDP packet construction/parsing for Spinel PROP_STREAM_NET.
 *
 * The NCP expects raw IPv6 packets. We construct a minimal IPv6 header
 * (40 bytes) + UDP header (8 bytes) + payload.
 *
 * If src_addr is provided, it is used and UDP checksum is computed.
 * If src_addr is NULL, source is :: and checksum is 0 (NCP may fill in).
 */

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define IPV6_HEADER_SIZE 40
#define UDP_HEADER_SIZE  8

/**
 * Build an IPv6+UDP packet wrapping a payload.
 *
 * @param pkt         Output buffer
 * @param pkt_size    Output buffer size
 * @param src_addr    16-byte IPv6 source address (NULL for ::)
 * @param dst_addr    16-byte IPv6 destination address
 * @param src_port    UDP source port
 * @param dst_port    UDP destination port
 * @param payload     Payload data
 * @param payload_len Payload length
 * @return Total packet length, or 0 on error
 */
size_t ipv6_udp_build(uint8_t* pkt, size_t pkt_size, const uint8_t* src_addr, const uint8_t* dst_addr,
                      uint16_t src_port, uint16_t dst_port, const uint8_t* payload, size_t payload_len);

/**
 * Parse an incoming IPv6+UDP packet.
 *
 * @param pkt         Input packet
 * @param pkt_len     Input packet length
 * @param src_addr    16-byte output for source IPv6 address (may be NULL)
 * @param src_port    Output for UDP source port (may be NULL)
 * @param dst_port    Output for UDP destination port (may be NULL)
 * @param payload_len Output for payload length
 * @return Pointer to UDP payload, or NULL if not UDP/malformed
 */
const uint8_t* ipv6_udp_parse(const uint8_t* pkt, size_t pkt_len, uint8_t* src_addr, uint16_t* src_port,
                              uint16_t* dst_port, size_t* payload_len);

#ifdef __cplusplus
}
#endif

#endif /* IPV6_UDP_H */
