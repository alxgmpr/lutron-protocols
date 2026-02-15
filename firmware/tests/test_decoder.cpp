/**
 * CCA decoder tests — verify full decode pipeline with real-ish packets.
 */

#include "cca_crc.h"
#include "cca_n81.h"
#include "cca_types.h"
#include "cca_decoder.h"
#include <cstdio>
#include <cstring>

extern int test_fail_count;
extern void test_registry_add(const char *name, void (*func)());

#define TEST(name) \
    static void test_##name(); \
    static struct test_reg_##name { \
        test_reg_##name() { test_registry_add(#name, test_##name); } \
    } test_reg_inst_##name; \
    static void test_##name()

#define ASSERT_EQ(a, b) do { \
    auto _a = (a); auto _b = (b); \
    if (_a != _b) { \
        printf("  FAIL: %s:%d: %s == %lld, expected %lld\n", \
               __FILE__, __LINE__, #a, (long long)_a, (long long)_b); \
        test_fail_count++; \
        return; \
    } \
} while (0)

#define ASSERT_TRUE(expr) do { \
    if (!(expr)) { \
        printf("  FAIL: %s:%d: %s\n", __FILE__, __LINE__, #expr); \
        test_fail_count++; \
        return; \
    } \
} while (0)

/* Build a synthetic CC1101 FIFO buffer: N81-encode a packet with valid CRC */
static size_t build_fifo(const uint8_t *pkt, size_t pkt_len,
                          uint8_t *fifo, size_t fifo_size)
{
    /* Append CRC */
    uint8_t with_crc[64];
    cca_append_crc(pkt, pkt_len, with_crc);

    /* N81 encode with preamble+sync */
    return n81_encode_packet(with_crc, pkt_len + 2, fifo, fifo_size);
}

/* Decode a button press packet */
TEST(decoder_button_press)
{
    uint8_t pkt[22] = {};
    pkt[0] = PKT_BUTTON_SHORT_A;  /* 0x88 */
    pkt[1] = 0x42;                 /* sequence */
    pkt[2] = 0x4E; pkt[3] = 0x10; /* device ID (BE) */
    pkt[4] = 0xA2; pkt[5] = 0xC7;
    pkt[7] = 0x02;                 /* format */
    pkt[10] = BTN_ON;              /* button */
    pkt[11] = ACTION_PRESS;        /* action */

    uint8_t fifo[256];
    size_t flen = build_fifo(pkt, 22, fifo, sizeof(fifo));
    ASSERT_TRUE(flen > 0);

    CcaDecoder dec;
    DecodedPacket result;
    result.clear();
    bool ok = dec.decode(fifo, flen, result);
    ASSERT_TRUE(ok);
    ASSERT_TRUE(result.valid);
    ASSERT_EQ(result.type_byte, (uint8_t)0x88);
    ASSERT_EQ(result.sequence, (uint8_t)0x42);
    ASSERT_EQ(result.device_id, (uint32_t)0x4E10A2C7);
    ASSERT_EQ(result.button, BTN_ON);
    ASSERT_EQ(result.action, ACTION_PRESS);
    ASSERT_TRUE(result.crc_valid);
}

/* Decode a state report */
TEST(decoder_state_report)
{
    uint8_t pkt[22] = {};
    pkt[0] = 0x81;               /* STATE_REPORT_81 */
    pkt[1] = 0x10;               /* sequence */
    /* Device ID LE: 0x12345678 */
    pkt[2] = 0x78; pkt[3] = 0x56; pkt[4] = 0x34; pkt[5] = 0x12;
    pkt[7] = 0x08;               /* format: simple state */
    pkt[11] = 127;               /* level (raw) */

    uint8_t fifo[256];
    size_t flen = build_fifo(pkt, 22, fifo, sizeof(fifo));
    ASSERT_TRUE(flen > 0);

    CcaDecoder dec;
    DecodedPacket result;
    result.clear();
    bool ok = dec.decode(fifo, flen, result);
    ASSERT_TRUE(ok);
    ASSERT_TRUE(result.valid);
    ASSERT_EQ(result.type_byte, (uint8_t)0x81);
    ASSERT_EQ(result.device_id, (uint32_t)0x12345678);
    ASSERT_TRUE(result.crc_valid);
}

/* Dimmer ACK validation */
TEST(decoder_dimmer_ack)
{
    /* Dimmer ACK: 5-byte format [0x0B, seq, b2, seq^0x26, b4] */
    uint8_t pkt[] = {0x0B, 0x42, 0xFE ^ 0x55, 0x42 ^ 0x26, 0xFE ^ 0x99};

    /* N81-encode directly (dimmer ACK has no CRC).
     * Pad FIFO to 32 bytes — decoder requires >= 200 bits. */
    uint8_t fifo[128];
    memset(fifo, 0, sizeof(fifo));
    size_t flen = n81_encode_packet(pkt, 5, fifo, sizeof(fifo));
    if (flen < 32) flen = 32;  /* pad to satisfy decoder minimum */
    ASSERT_TRUE(flen > 0);

    CcaDecoder dec;
    DecodedPacket result;
    result.clear();
    bool ok = dec.decode(fifo, flen, result);
    ASSERT_TRUE(ok);
    ASSERT_TRUE(result.valid);
    ASSERT_EQ(result.type_byte, (uint8_t)0x0B);
    ASSERT_EQ(result.sequence, (uint8_t)0x42);
}

/* Packet type classification */
TEST(decoder_type_classification)
{
    ASSERT_TRUE(cca_is_button_type(0x88));
    ASSERT_TRUE(cca_is_button_type(0x89));
    ASSERT_TRUE(cca_is_button_type(0x8A));
    ASSERT_TRUE(cca_is_button_type(0x8B));
    ASSERT_TRUE(!cca_is_button_type(0x80));
    ASSERT_TRUE(!cca_is_button_type(0x91));

    ASSERT_TRUE(cca_is_pairing_type(0xB0));
    ASSERT_TRUE(cca_is_pairing_type(0xB8));
    ASSERT_TRUE(!cca_is_pairing_type(0x88));

    ASSERT_EQ(cca_get_packet_length(0x0B), 5);
    ASSERT_EQ(cca_get_packet_length(0x88), 24);
    ASSERT_EQ(cca_get_packet_length(0xA2), 53);
    ASSERT_EQ(cca_get_packet_length(0xC0), 24);
}

/* parse_bytes with valid CRC */
TEST(decoder_parse_bytes_valid_crc)
{
    uint8_t pkt[24] = {};
    pkt[0] = 0x88;
    pkt[1] = 0x55;
    pkt[2] = 0x11; pkt[3] = 0x22; pkt[4] = 0x33; pkt[5] = 0x44;
    pkt[10] = BTN_OFF;
    pkt[11] = ACTION_RELEASE;

    /* Append CRC at [22..23] */
    uint16_t crc = cca_calc_crc(pkt, 22);
    pkt[22] = (uint8_t)(crc >> 8);
    pkt[23] = (uint8_t)(crc & 0xFF);

    CcaDecoder dec;
    DecodedPacket result;
    result.clear();
    bool ok = dec.parse_bytes(pkt, 24, result);
    ASSERT_TRUE(ok);
    ASSERT_TRUE(result.crc_valid);
    ASSERT_EQ(result.device_id, (uint32_t)0x11223344);
    ASSERT_EQ(result.button, BTN_OFF);
}

/* CRC recovery: 1 corrupted data byte */
TEST(crc_recover_1_data_error)
{
    uint8_t pkt[24] = {};
    pkt[0] = 0x88;
    pkt[1] = 0x42;  /* sequence — this will be corrupted */
    pkt[2] = 0x4E; pkt[3] = 0x10; pkt[4] = 0xA2; pkt[5] = 0xC7;
    pkt[7] = 0x02;
    pkt[10] = BTN_ON;
    pkt[11] = ACTION_PRESS;

    uint16_t crc = cca_calc_crc(pkt, 22);
    pkt[22] = (uint8_t)(crc >> 8);
    pkt[23] = (uint8_t)(crc & 0xFF);

    /* Corrupt byte 1 (sequence) to 0xCC as tolerant decoder would */
    pkt[1] = 0xCC;
    uint8_t err_pos[1] = {1};

    size_t candidates[] = {24, 53};
    int match = cca_recover_n81_errors(pkt, 24, candidates, 2, err_pos, 1);
    ASSERT_EQ(match, 24);
    ASSERT_EQ(pkt[1], (uint8_t)0x42);  /* recovered original value */
}

/* CRC recovery: 1 corrupted CRC byte (data intact) */
TEST(crc_recover_1_crc_error)
{
    uint8_t pkt[24] = {};
    pkt[0] = 0x88;
    pkt[1] = 0x42;
    pkt[2] = 0x4E; pkt[3] = 0x10; pkt[4] = 0xA2; pkt[5] = 0xC7;
    pkt[10] = BTN_ON;

    uint16_t crc = cca_calc_crc(pkt, 22);
    pkt[22] = (uint8_t)(crc >> 8);
    pkt[23] = (uint8_t)(crc & 0xFF);

    uint8_t orig_crc_lo = pkt[23];
    pkt[23] = 0xCC;  /* corrupt CRC low byte */
    uint8_t err_pos[1] = {23};

    size_t candidates[] = {24, 53};
    int match = cca_recover_n81_errors(pkt, 24, candidates, 2, err_pos, 1);
    ASSERT_EQ(match, 24);
    ASSERT_EQ(pkt[23], orig_crc_lo);  /* CRC byte recomputed correctly */
}

/* CRC recovery: 2 corrupted data bytes */
TEST(crc_recover_2_data_errors)
{
    uint8_t pkt[24] = {};
    pkt[0] = 0x88;
    pkt[1] = 0x42;  /* will corrupt */
    pkt[2] = 0x4E; pkt[3] = 0x10; pkt[4] = 0xA2; pkt[5] = 0xC7;
    pkt[7] = 0x02;
    pkt[10] = BTN_ON;
    pkt[11] = ACTION_PRESS;
    pkt[15] = 0x37;  /* will corrupt */

    uint16_t crc = cca_calc_crc(pkt, 22);
    pkt[22] = (uint8_t)(crc >> 8);
    pkt[23] = (uint8_t)(crc & 0xFF);

    pkt[1] = 0xCC;
    pkt[15] = 0xCC;
    uint8_t err_pos[2] = {1, 15};

    size_t candidates[] = {24, 53};
    int match = cca_recover_n81_errors(pkt, 24, candidates, 2, err_pos, 2);
    ASSERT_EQ(match, 24);
    ASSERT_EQ(pkt[1], (uint8_t)0x42);
    ASSERT_EQ(pkt[15], (uint8_t)0x37);
}

/* CRC recovery: 1 data error + 1 CRC error */
TEST(crc_recover_1_data_1_crc_error)
{
    uint8_t pkt[24] = {};
    pkt[0] = 0x88;
    pkt[1] = 0x42;  /* will corrupt */
    pkt[2] = 0x4E; pkt[3] = 0x10; pkt[4] = 0xA2; pkt[5] = 0xC7;
    pkt[10] = BTN_ON;

    uint16_t crc = cca_calc_crc(pkt, 22);
    pkt[22] = (uint8_t)(crc >> 8);
    pkt[23] = (uint8_t)(crc & 0xFF);

    pkt[1] = 0xCC;
    pkt[22] = 0xCC;  /* corrupt CRC high byte */
    uint8_t err_pos[2] = {1, 22};

    size_t candidates[] = {24, 53};
    int match = cca_recover_n81_errors(pkt, 24, candidates, 2, err_pos, 2);
    ASSERT_EQ(match, 24);
    ASSERT_EQ(pkt[1], (uint8_t)0x42);
    /* CRC should be recomputed correctly */
    uint16_t final_crc = cca_calc_crc(pkt, 22);
    uint16_t stored_crc = (static_cast<uint16_t>(pkt[22]) << 8) | pkt[23];
    ASSERT_EQ(final_crc, stored_crc);
}

/* Sliding CRC: packet at non-standard length */
TEST(crc_sliding_nonstandard_length)
{
    /* 18-byte "packet" with CRC at bytes 16-17 */
    uint8_t pkt[18] = {};
    pkt[0] = 0x42;
    pkt[1] = 0x55;
    for (int i = 2; i < 16; i++) pkt[i] = (uint8_t)(i * 7);
    uint16_t crc = cca_calc_crc(pkt, 16);
    pkt[16] = (uint8_t)(crc >> 8);
    pkt[17] = (uint8_t)(crc & 0xFF);

    int match = cca_check_crc_sliding(pkt, 18);
    ASSERT_EQ(match, 18);

    /* Fixed-length check should NOT find it (18 is not 24 or 53) */
    size_t candidates[] = {24, 53};
    int fixed = cca_check_crc_at_lengths(pkt, 18, candidates, 2);
    ASSERT_EQ(fixed, -1);
}

/* Full pipeline: tolerant decode with N81 error should recover via CRC */
TEST(decoder_n81_recovery_pipeline)
{
    uint8_t pkt[22] = {};
    pkt[0] = PKT_BUTTON_SHORT_A;
    pkt[1] = 0x30;  /* sequence */
    pkt[2] = 0x08; pkt[3] = 0x69; pkt[4] = 0x2D; pkt[5] = 0x70;
    pkt[7] = 0x02;
    pkt[10] = BTN_SCENE4;
    pkt[11] = ACTION_PRESS;

    /* Build valid FIFO with CRC */
    uint8_t fifo[256];
    size_t flen = build_fifo(pkt, 22, fifo, sizeof(fifo));
    ASSERT_TRUE(flen > 0);

    /* Corrupt one N81 frame in the FIFO to simulate RF error.
     * Byte 1 (sequence) starts at bit 62+10=72 in the N81 stream
     * (after 32 preamble + 30 prefix bits + 10 bits for byte 0).
     * Flip the stop bit (bit 81) to create an N81 framing error. */
    size_t seq_stop_bit = 32 + 30 + 10 + 9;  /* stop bit of byte 1 */
    size_t byte_idx = seq_stop_bit / 8;
    int bit_off = 7 - (seq_stop_bit % 8);
    if (byte_idx < flen) {
        fifo[byte_idx] ^= (1 << bit_off);  /* flip stop bit */
    }

    CcaDecoder dec;
    DecodedPacket result;
    result.clear();
    bool ok = dec.decode(fifo, flen, result);
    ASSERT_TRUE(ok);
    ASSERT_TRUE(result.valid);
    ASSERT_EQ(result.type_byte, (uint8_t)0x88);
    ASSERT_EQ(result.device_id, (uint32_t)0x08692D70);
    ASSERT_TRUE(result.crc_valid);
    ASSERT_TRUE(result.n81_errors > 0);  /* had errors but recovered */
}
