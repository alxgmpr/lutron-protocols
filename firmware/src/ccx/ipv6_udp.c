#include "ipv6_udp.h"
#include <string.h>

#define IPV6_NEXT_HEADER_UDP  17

size_t ipv6_udp_build(uint8_t *pkt, size_t pkt_size,
                       const uint8_t *dst_addr,
                       uint16_t src_port, uint16_t dst_port,
                       const uint8_t *payload, size_t payload_len)
{
    size_t udp_len = UDP_HEADER_SIZE + payload_len;
    size_t total = IPV6_HEADER_SIZE + udp_len;

    if (total > pkt_size || payload_len > 0xFFFF - UDP_HEADER_SIZE)
        return 0;

    memset(pkt, 0, IPV6_HEADER_SIZE + UDP_HEADER_SIZE);

    /* --- IPv6 header (40 bytes) --- */
    /* Version (4) + Traffic Class (8) + Flow Label (20) = 0x60000000 */
    pkt[0] = 0x60;
    /* pkt[1..3] = 0 (traffic class + flow label) */

    /* Payload length (16-bit big-endian) = UDP header + UDP payload */
    pkt[4] = (uint8_t)(udp_len >> 8);
    pkt[5] = (uint8_t)(udp_len & 0xFF);

    /* Next Header = UDP (17) */
    pkt[6] = IPV6_NEXT_HEADER_UDP;

    /* Hop Limit = 64 */
    pkt[7] = 64;

    /* Source address: :: (all zeros — NCP fills in) */
    /* Already zeroed by memset */

    /* Destination address (bytes 24-39) */
    memcpy(pkt + 24, dst_addr, 16);

    /* --- UDP header (8 bytes at offset 40) --- */
    uint8_t *udp = pkt + IPV6_HEADER_SIZE;

    /* Source port (big-endian) */
    udp[0] = (uint8_t)(src_port >> 8);
    udp[1] = (uint8_t)(src_port & 0xFF);

    /* Destination port (big-endian) */
    udp[2] = (uint8_t)(dst_port >> 8);
    udp[3] = (uint8_t)(dst_port & 0xFF);

    /* UDP length (big-endian) */
    udp[4] = (uint8_t)(udp_len >> 8);
    udp[5] = (uint8_t)(udp_len & 0xFF);

    /* Checksum = 0 (NCP computes) */
    /* Already zeroed by memset */

    /* --- Payload --- */
    memcpy(pkt + IPV6_HEADER_SIZE + UDP_HEADER_SIZE, payload, payload_len);

    return total;
}

const uint8_t *ipv6_udp_parse(const uint8_t *pkt, size_t pkt_len,
                               uint8_t *src_addr,
                               uint16_t *src_port, uint16_t *dst_port,
                               size_t *payload_len)
{
    /* Need at least IPv6 header + UDP header */
    if (pkt_len < IPV6_HEADER_SIZE + UDP_HEADER_SIZE)
        return NULL;

    /* Verify IPv6 version (top nibble = 6) */
    if ((pkt[0] >> 4) != 6)
        return NULL;

    /* Check Next Header == UDP */
    if (pkt[6] != IPV6_NEXT_HEADER_UDP)
        return NULL;

    /* Extract source address (bytes 8-23) */
    if (src_addr)
        memcpy(src_addr, pkt + 8, 16);

    const uint8_t *udp = pkt + IPV6_HEADER_SIZE;

    if (src_port)
        *src_port = ((uint16_t)udp[0] << 8) | udp[1];
    if (dst_port)
        *dst_port = ((uint16_t)udp[2] << 8) | udp[3];

    uint16_t udp_len = ((uint16_t)udp[4] << 8) | udp[5];

    if (udp_len < UDP_HEADER_SIZE)
        return NULL;

    size_t data_len = udp_len - UDP_HEADER_SIZE;

    /* Verify we have enough bytes */
    if ((size_t)IPV6_HEADER_SIZE + udp_len > pkt_len)
        return NULL;

    if (payload_len)
        *payload_len = data_len;

    return udp + UDP_HEADER_SIZE;
}
