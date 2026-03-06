#include "ipv6_udp.h"
#include <string.h>

#define IPV6_NEXT_HEADER_UDP 17

/* Compute UDP checksum over IPv6 pseudo-header + UDP header + payload */
static uint16_t udp_checksum(const uint8_t* src_addr, const uint8_t* dst_addr,
                             uint16_t udp_len, const uint8_t* udp_hdr, const uint8_t* payload, size_t payload_len)
{
    uint32_t sum = 0;

    /* Pseudo-header: src addr (16) + dst addr (16) + UDP length (4) + next header (4) */
    for (int i = 0; i < 16; i += 2)
        sum += ((uint32_t)src_addr[i] << 8) | src_addr[i + 1];
    for (int i = 0; i < 16; i += 2)
        sum += ((uint32_t)dst_addr[i] << 8) | dst_addr[i + 1];
    sum += udp_len;
    sum += IPV6_NEXT_HEADER_UDP;

    /* UDP header (8 bytes, checksum field treated as 0) */
    sum += ((uint32_t)udp_hdr[0] << 8) | udp_hdr[1]; /* src port */
    sum += ((uint32_t)udp_hdr[2] << 8) | udp_hdr[3]; /* dst port */
    sum += ((uint32_t)udp_hdr[4] << 8) | udp_hdr[5]; /* length */
    /* checksum field = 0 (skip) */

    /* Payload */
    size_t i;
    for (i = 0; i + 1 < payload_len; i += 2)
        sum += ((uint32_t)payload[i] << 8) | payload[i + 1];
    if (i < payload_len)
        sum += (uint32_t)payload[i] << 8; /* odd byte */

    /* Fold carries */
    while (sum >> 16)
        sum = (sum & 0xFFFF) + (sum >> 16);

    uint16_t result = (uint16_t)~sum;
    return (result == 0) ? 0xFFFF : result; /* 0 means "no checksum" in UDP, use 0xFFFF */
}

size_t ipv6_udp_build(uint8_t* pkt, size_t pkt_size, const uint8_t* src_addr, const uint8_t* dst_addr,
                      uint16_t src_port, uint16_t dst_port, const uint8_t* payload, size_t payload_len)
{
    size_t udp_len = UDP_HEADER_SIZE + payload_len;
    size_t total = IPV6_HEADER_SIZE + udp_len;

    if (total > pkt_size || payload_len > 0xFFFF - UDP_HEADER_SIZE) return 0;

    memset(pkt, 0, IPV6_HEADER_SIZE + UDP_HEADER_SIZE);

    /* --- IPv6 header (40 bytes) --- */
    pkt[0] = 0x60;

    /* Payload length (16-bit big-endian) = UDP header + UDP payload */
    pkt[4] = (uint8_t)(udp_len >> 8);
    pkt[5] = (uint8_t)(udp_len & 0xFF);

    /* Next Header = UDP (17) */
    pkt[6] = IPV6_NEXT_HEADER_UDP;

    /* Hop Limit = 64 */
    pkt[7] = 64;

    /* Source address (bytes 8-23) */
    if (src_addr)
        memcpy(pkt + 8, src_addr, 16);
    /* else: already zeroed (::) */

    /* Destination address (bytes 24-39) */
    memcpy(pkt + 24, dst_addr, 16);

    /* --- UDP header (8 bytes at offset 40) --- */
    uint8_t* udp = pkt + IPV6_HEADER_SIZE;

    udp[0] = (uint8_t)(src_port >> 8);
    udp[1] = (uint8_t)(src_port & 0xFF);
    udp[2] = (uint8_t)(dst_port >> 8);
    udp[3] = (uint8_t)(dst_port & 0xFF);
    udp[4] = (uint8_t)(udp_len >> 8);
    udp[5] = (uint8_t)(udp_len & 0xFF);

    /* --- Payload --- */
    memcpy(pkt + IPV6_HEADER_SIZE + UDP_HEADER_SIZE, payload, payload_len);

    /* --- UDP checksum --- */
    if (src_addr) {
        uint16_t cksum = udp_checksum(pkt + 8, pkt + 24, (uint16_t)udp_len, udp, payload, payload_len);
        udp[6] = (uint8_t)(cksum >> 8);
        udp[7] = (uint8_t)(cksum & 0xFF);
    }
    /* else: checksum stays 0 (hope NCP computes it) */

    return total;
}

const uint8_t* ipv6_udp_parse(const uint8_t* pkt, size_t pkt_len, uint8_t* src_addr, uint16_t* src_port,
                              uint16_t* dst_port, size_t* payload_len)
{
    /* Need at least IPv6 header + UDP header */
    if (pkt_len < IPV6_HEADER_SIZE + UDP_HEADER_SIZE) return NULL;

    /* Verify IPv6 version (top nibble = 6) */
    if ((pkt[0] >> 4) != 6) return NULL;

    /* Check Next Header == UDP */
    if (pkt[6] != IPV6_NEXT_HEADER_UDP) return NULL;

    /* Extract source address (bytes 8-23) */
    if (src_addr) memcpy(src_addr, pkt + 8, 16);

    const uint8_t* udp = pkt + IPV6_HEADER_SIZE;

    if (src_port) *src_port = ((uint16_t)udp[0] << 8) | udp[1];
    if (dst_port) *dst_port = ((uint16_t)udp[2] << 8) | udp[3];

    uint16_t udp_len = ((uint16_t)udp[4] << 8) | udp[5];

    if (udp_len < UDP_HEADER_SIZE) return NULL;

    size_t data_len = udp_len - UDP_HEADER_SIZE;

    /* Verify we have enough bytes */
    if ((size_t)IPV6_HEADER_SIZE + udp_len > pkt_len) return NULL;

    if (payload_len) *payload_len = data_len;

    return udp + UDP_HEADER_SIZE;
}
