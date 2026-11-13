/**
 * Flipper app text rendering (apps/flipper/lutron_cca/cca_describe.h): list rows,
 * detail lines, repeat collapsing.
 */

#include "cca_decoder.h"
#include "test_harness.h"

#include "../../apps/flipper/lutron_cca/cca_describe.h"

static DecodedPacket parse(const uint8_t* payload22)
{
    uint8_t raw[24];
    cca_append_crc(payload22, 22, raw);
    DecodedPacket p;
    p.clear();
    CcaDecoder::parse_bytes(raw, 24, p);
    return p;
}

TEST(flipper_describe_button_row)
{
    uint8_t b[22] = {0x88, 0x01, 0x05, 0x95, 0xE6, 0x8D, 0x21, 0x04, 0x03, 0x00, BTN_ON, ACTION_PRESS};
    DecodedPacket p = parse(b);
    char row[CCA_LINE_LEN];
    cca_describe_row(p, row, sizeof(row));
    ASSERT_TRUE(!strcmp(row, "0595E68D ON press"));
    ASSERT_TRUE(cca_replayable(p));
}

TEST(flipper_describe_level_detail)
{
    uint8_t b[22] = {0x81, 0x02, 0x11, 0x22, 0x33, 0x44, 0x21, QS_FMT_LEVEL, 0x00, 0x06, 0xFD, 0xEF, 0xF4};
    b[16] = 0x7F; // 0x7F7F / 0xFEFF = 50%
    b[17] = 0x7F;
    b[19] = 10; // 2.5 s
    DecodedPacket p = parse(b);
    char row[CCA_LINE_LEN];
    cca_describe_row(p, row, sizeof(row));
    ASSERT_TRUE(!strcmp(row, "44332211 set 50%"));

    char lines[CCA_DETAIL_MAX][CCA_LINE_LEN];
    int n = cca_detail_lines(p, -62, -7, 3, lines, CCA_DETAIL_MAX);
    ASSERT_EQ(n, 10); // 6 info + 4 hex
    ASSERT_TRUE(!strcmp(lines[1], "Target 06FDEFF4"));
    ASSERT_TRUE(!strcmp(lines[2], "Fade 2.50s"));
    ASSERT_TRUE(!strcmp(lines[3], "Seq 0x02  heard x3"));
    ASSERT_TRUE(!strcmp(lines[4], "RSSI -62dBm"));
    ASSERT_TRUE(!strcmp(lines[5], "Freq offset -11.1kHz"));
    ASSERT_TRUE(!strcmp(lines[6], "81 02 11 22 33 44"));
}

TEST(flipper_describe_same_packet_ignores_seq)
{
    uint8_t b[22] = {0x88, 0x01, 0x05, 0x95, 0xE6, 0x8D, 0x21, 0x04, 0x03, 0x00, BTN_ON, ACTION_PRESS};
    DecodedPacket a = parse(b);
    b[1] = 0x09;
    DecodedPacket again = parse(b);
    b[11] = ACTION_RELEASE;
    DecodedPacket release = parse(b);
    ASSERT_TRUE(cca_same_packet(a, again));
    ASSERT_FALSE(cca_same_packet(a, release));
}

TEST(flipper_describe_detail_53_bytes_fits)
{
    DecodedPacket p;
    p.clear();
    p.type_byte = p.type = 0xB0;
    p.raw_len = 53;
    p.target_id = 1;
    char lines[CCA_DETAIL_MAX][CCA_LINE_LEN];
    ASSERT_TRUE(cca_detail_lines(p, -90, 0, 1, lines, CCA_DETAIL_MAX) <= CCA_DETAIL_MAX);
    ASSERT_FALSE(cca_replayable(p));
}
