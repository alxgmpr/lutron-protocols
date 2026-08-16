/**
 * Intel HEX parsing tests.
 *
 * Vectors are taken from firmware/ncp/ot-ncp-ftd.hex, the artifact we actually
 * have to flash. That file uses record type 02 (Extended Segment Address),
 * not the type 04 (Extended Linear Address) most parsers assume — a parser
 * that only handles 04 silently places the entire image at the wrong address
 * and every byte lands in the wrong page.
 */

#include "ihex.h"
#include "test_harness.h"

#include <cstring>

namespace {

/* Collects what the parser emits so tests can assert on it. */
struct Sink {
    static const int MAX = 64;
    uint32_t addr[MAX];
    uint8_t data[MAX][255];
    uint8_t len[MAX];
    int count = 0;

    static int emit(void* ctx, uint32_t a, const uint8_t* d, uint8_t n)
    {
        Sink* s = static_cast<Sink*>(ctx);
        if (s->count >= MAX) {
            return -1;
        }
        s->addr[s->count] = a;
        s->len[s->count] = n;
        memcpy(s->data[s->count], d, n);
        s->count++;
        return 0;
    }
};

ihex_status_t feed(ihex_t* h, const char* line, Sink* sink)
{
    return ihex_parse_line(h, line, strlen(line), &Sink::emit, sink);
}

} // namespace

/* -----------------------------------------------------------------------
 * Data records
 * ----------------------------------------------------------------------- */

TEST(ihex_parses_a_data_record_from_the_real_image)
{
    ihex_t h;
    ihex_init(&h);
    Sink s;

    /* First line of ot-ncp-ftd.hex. */
    ASSERT_EQ(feed(&h, ":101000000000042091150300B9150300BB1503006F", &s), IHEX_OK);
    ASSERT_EQ(s.count, 1);
    ASSERT_EQ(s.addr[0], 0x1000u);
    ASSERT_EQ(s.len[0], 16);

    /* Little-endian initial stack pointer, 0x20040000 — top of the nRF's RAM. */
    const uint8_t want[4] = {0x00, 0x00, 0x04, 0x20};
    ASSERT_MEM_EQ(s.data[0], want, 4);
}

TEST(ihex_tolerates_trailing_newline_and_carriage_return)
{
    ihex_t h;
    ihex_init(&h);
    Sink s;
    ASSERT_EQ(feed(&h, ":101000000000042091150300B9150300BB1503006F\r\n", &s), IHEX_OK);
    ASSERT_EQ(s.count, 1);
}

TEST(ihex_skips_a_blank_line)
{
    ihex_t h;
    ihex_init(&h);
    Sink s;
    ASSERT_EQ(feed(&h, "", &s), IHEX_OK);
    ASSERT_EQ(feed(&h, "\r\n", &s), IHEX_OK);
    ASSERT_EQ(s.count, 0);
}

/* -----------------------------------------------------------------------
 * Malformed input
 * ----------------------------------------------------------------------- */

TEST(ihex_rejects_a_line_without_the_start_code)
{
    ihex_t h;
    ihex_init(&h);
    Sink s;
    ASSERT_EQ(feed(&h, "101000000000042091150300B9150300BB1503006F", &s), IHEX_ERR_FORMAT);
}

TEST(ihex_rejects_a_bad_checksum)
{
    ihex_t h;
    ihex_init(&h);
    Sink s;
    /* Same first line with the checksum one off. */
    ASSERT_EQ(feed(&h, ":101000000000042091150300B9150300BB15030070", &s), IHEX_ERR_CHECKSUM);
    ASSERT_EQ(s.count, 0);
}

TEST(ihex_rejects_a_corrupted_payload_byte)
{
    /* The checksum is what makes a flipped data byte detectable at all. */
    ihex_t h;
    ihex_init(&h);
    Sink s;
    ASSERT_EQ(feed(&h, ":101000000000042091150300B9150300BB1503016F", &s), IHEX_ERR_CHECKSUM);
}

TEST(ihex_rejects_a_non_hex_digit)
{
    ihex_t h;
    ihex_init(&h);
    Sink s;
    ASSERT_EQ(feed(&h, ":1010000000000420911503ZZB9150300BB1503006F", &s), IHEX_ERR_FORMAT);
}

TEST(ihex_rejects_a_truncated_line)
{
    ihex_t h;
    ihex_init(&h);
    Sink s;
    ASSERT_EQ(feed(&h, ":10100000000004209115", &s), IHEX_ERR_FORMAT);
}

TEST(ihex_rejects_trailing_bytes_after_the_checksum)
{
    /* The declared count has to describe the line exactly. Accepting extra
       characters means a corrupted or concatenated line still parses, and the
       checksum does not catch it because it sits at the expected offset. */
    ihex_t h;
    ihex_init(&h);
    Sink s;
    ASSERT_EQ(feed(&h, ":101000000000042091150300B9150300BB1503006F00", &s), IHEX_ERR_FORMAT);
    ASSERT_EQ(feed(&h, ":00000001FFFF", &s), IHEX_ERR_FORMAT);
}

TEST(ihex_rejects_a_line_shorter_than_a_header)
{
    ihex_t h;
    ihex_init(&h);
    Sink s;
    ASSERT_EQ(feed(&h, ":10", &s), IHEX_ERR_FORMAT);
}

TEST(ihex_rejects_an_unknown_record_type)
{
    ihex_t h;
    ihex_init(&h);
    Sink s;
    ASSERT_EQ(feed(&h, ":00000009F7", &s), IHEX_ERR_RECORD);
}

/* -----------------------------------------------------------------------
 * Address extension records
 * ----------------------------------------------------------------------- */

TEST(ihex_extended_segment_address_shifts_by_four_bits)
{
    /* Type 02 with value 0x1000 means a base of 0x10000, not 0x1000. Getting
       this wrong puts the whole image 60 KB low. */
    ihex_t h;
    ihex_init(&h);
    Sink s;

    ASSERT_EQ(feed(&h, ":020000021000EC", &s), IHEX_OK);
    ASSERT_EQ(feed(&h, ":04000000DEADBEEFC4", &s), IHEX_OK);
    ASSERT_EQ(s.count, 1);
    ASSERT_EQ(s.addr[0], 0x10000u);
}

TEST(ihex_extended_segment_address_adds_the_record_offset)
{
    ihex_t h;
    ihex_init(&h);
    Sink s;
    ASSERT_EQ(feed(&h, ":020000022000DC", &s), IHEX_OK);
    ASSERT_EQ(feed(&h, ":0412340000000000B6", &s), IHEX_OK);
    ASSERT_EQ(s.addr[0], 0x20000u + 0x1234u);
}

TEST(ihex_extended_linear_address_shifts_by_sixteen_bits)
{
    ihex_t h;
    ihex_init(&h);
    Sink s;
    ASSERT_EQ(feed(&h, ":02000004000FEB", &s), IHEX_OK);
    ASSERT_EQ(feed(&h, ":04100000DEADBEEFB4", &s), IHEX_OK);
    ASSERT_EQ(s.addr[0], 0x000F1000u);
}

TEST(ihex_a_new_extension_record_replaces_the_previous_base)
{
    ihex_t h;
    ihex_init(&h);
    Sink s;
    ASSERT_EQ(feed(&h, ":020000021000EC", &s), IHEX_OK);
    ASSERT_EQ(feed(&h, ":020000023000CC", &s), IHEX_OK);
    ASSERT_EQ(feed(&h, ":04000000DEADBEEFC4", &s), IHEX_OK);
    ASSERT_EQ(s.addr[0], 0x30000u);
}

TEST(ihex_start_address_records_are_accepted_and_ignored)
{
    /* Types 03 and 05 carry an entry point, not an address base. Treating 03
       as an address extension is a classic way to corrupt the tail of an
       image — ot-ncp-ftd.hex ends with one. */
    ihex_t h;
    ihex_init(&h);
    Sink s;

    ASSERT_EQ(feed(&h, ":020000021000EC", &s), IHEX_OK);
    ASSERT_EQ(feed(&h, ":040000033000159123", &s), IHEX_OK);
    ASSERT_EQ(feed(&h, ":04000000DEADBEEFC4", &s), IHEX_OK);
    ASSERT_EQ(s.count, 1);
    ASSERT_EQ(s.addr[0], 0x10000u); /* base unchanged by the type 03 */
}

/* -----------------------------------------------------------------------
 * End of file
 * ----------------------------------------------------------------------- */

TEST(ihex_is_not_complete_until_the_eof_record)
{
    ihex_t h;
    ihex_init(&h);
    Sink s;
    ASSERT_FALSE(ihex_complete(&h));
    feed(&h, ":101000000000042091150300B9150300BB1503006F", &s);
    ASSERT_FALSE(ihex_complete(&h));
    ASSERT_EQ(feed(&h, ":00000001FF", &s), IHEX_OK);
    ASSERT_TRUE(ihex_complete(&h));
}

TEST(ihex_rejects_data_after_the_eof_record)
{
    /* A truncated transfer that happens to end on an EOF record followed by
       more data means the stream is not what it claims to be. */
    ihex_t h;
    ihex_init(&h);
    Sink s;
    ASSERT_EQ(feed(&h, ":00000001FF", &s), IHEX_OK);
    ASSERT_EQ(feed(&h, ":101000000000042091150300B9150300BB1503006F", &s), IHEX_ERR_RECORD);
}

/* -----------------------------------------------------------------------
 * Address range tracking
 * ----------------------------------------------------------------------- */

TEST(ihex_tracks_the_address_span_it_has_seen)
{
    ihex_t h;
    ihex_init(&h);
    Sink s;

    feed(&h, ":101000000000042091150300B9150300BB1503006F", &s);
    ASSERT_EQ(ihex_min_address(&h), 0x1000u);
    ASSERT_EQ(ihex_max_address(&h), 0x1010u); /* exclusive end */

    feed(&h, ":020000021000EC", &s);
    feed(&h, ":04000000DEADBEEFC4", &s);
    ASSERT_EQ(ihex_min_address(&h), 0x1000u);
    ASSERT_EQ(ihex_max_address(&h), 0x10004u);
}

TEST(ihex_reports_an_empty_span_before_any_data)
{
    ihex_t h;
    ihex_init(&h);
    ASSERT_EQ(ihex_min_address(&h), 0u);
    ASSERT_EQ(ihex_max_address(&h), 0u);
}

/* -----------------------------------------------------------------------
 * The real artifact
 * ----------------------------------------------------------------------- */

TEST(ihex_parses_the_whole_ncp_image)
{
    /* End to end over firmware/ncp/ot-ncp-ftd.hex — 14077 data records using
       type 02 segment addressing. Synthetic vectors would not have caught the
       02-vs-04 distinction; this file is why the parser handles both. */
    struct Counter {
        uint32_t records = 0;
        uint32_t bytes = 0;
        static int emit(void* ctx, uint32_t, const uint8_t*, uint8_t n)
        {
            Counter* c = static_cast<Counter*>(ctx);
            c->records++;
            c->bytes += n;
            return 0;
        }
    };

    FILE* f = fopen("ncp/ot-ncp-ftd.hex", "r");
    ASSERT_TRUE(f != nullptr);

    ihex_t h;
    ihex_init(&h);
    Counter c;
    char line[600];
    int line_no = 0;
    while (fgets(line, sizeof(line), f) != nullptr) {
        line_no++;
        ihex_status_t st = ihex_parse_line(&h, line, strlen(line), &Counter::emit, &c);
        if (st != IHEX_OK) {
            printf("  (line %d returned %d) ", line_no, (int)st);
            fclose(f);
            ASSERT_EQ(st, IHEX_OK);
            return;
        }
    }
    fclose(f);

    ASSERT_TRUE(ihex_complete(&h));
    ASSERT_EQ(c.records, 14077u);
    ASSERT_EQ(c.bytes, 225208u);
    ASSERT_EQ(ihex_min_address(&h), 0x1000u);
    ASSERT_EQ(ihex_max_address(&h), 0x37FB8u);
}

/* -----------------------------------------------------------------------
 * Callback failure
 * ----------------------------------------------------------------------- */

TEST(ihex_propagates_a_sink_failure)
{
    /* If flashing the emitted bytes fails, parsing must stop rather than
       carry on and report a clean run. */
    struct Failing {
        static int emit(void*, uint32_t, const uint8_t*, uint8_t) { return -1; }
    };
    const char* line = ":101000000000042091150300B9150300BB1503006F";
    ihex_t h;
    ihex_init(&h);
    ASSERT_EQ(ihex_parse_line(&h, line, strlen(line), &Failing::emit, nullptr), IHEX_ERR_SINK);
}
