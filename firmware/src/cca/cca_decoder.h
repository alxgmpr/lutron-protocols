#pragma once

// CCA packet decoder — multi-sync FIFO decoder with CRC validation
// Ported from esphome/custom_components/cc1101_cca/cca_decoder.h
// Changes: stripped esphome::cc1101_cca namespace

#include "cca_crc.h"
#include "cca_n81.h"
#include "cca_protocol.h"
#include "cca_types.h"

class CcaDecoder {
  public:
    CcaDecoder() = default;

    static const size_t     MAX_DECODE_LEN = 56;
    static const size_t     MAX_SYNC_SEARCH = 500;
    static constexpr size_t CCA_LENGTHS[] = {24, 53};
    static const size_t     N_CCA_LENGTHS = 2;

    bool decode(const uint8_t* fifo_data, size_t len, DecodedPacket& packet)
    {
        size_t total_bits = len * 8;
        if (total_bits < 200) return false;

        /* Fast path: CC1101 already sync-matched on 0x7FCB and we prepended sync
     * bytes, so N81(FF FA DE) is always at bit 0. Try direct decode first
     * before falling back to the expensive bit-by-bit sync search. */
        int fast_start = try_fast_sync(fifo_data, len);
        if (fast_start >= 0) {
            if (try_decode_at_offset(fifo_data, len, static_cast<size_t>(fast_start), packet)) {
                return true;
            }
        }

        size_t        search_from = 0;
        bool          have_dimmer_ack = false;
        DecodedPacket dimmer_ack;
        dimmer_ack.clear();

        /* Track best candidate for CRC-optional fallback */
        uint8_t best_decoded[MAX_DECODE_LEN];
        size_t  best_decoded_len = 0;
        uint8_t best_errors = 255;
        uint8_t best_err_pos[2] = {};

        while (true) {
            int data_start = n81_find_sync_offset_from(fifo_data, len, search_from, MAX_SYNC_SEARCH);
            if (data_start < 0) break;

            uint8_t decoded[MAX_DECODE_LEN];
            size_t  decoded_len =
                n81_decode_stream(fifo_data, len, static_cast<size_t>(data_start), MAX_DECODE_LEN, decoded);

            if (decoded_len >= 10) {
                int match = cca_check_crc_at_lengths(decoded, decoded_len, CCA_LENGTHS, N_CCA_LENGTHS);
                if (match > 0) {
                    return parse_bytes_at_length(decoded, static_cast<size_t>(match), 0, packet);
                }
                /* Track as candidate if better than previous best */
                if (decoded_len > best_decoded_len || (decoded_len == best_decoded_len && 0 < best_errors)) {
                    memcpy(best_decoded, decoded, decoded_len);
                    best_decoded_len = decoded_len;
                    best_errors = 0;
                    best_err_pos[0] = best_err_pos[1] = 0;
                }
            }

            uint8_t tolerant[MAX_DECODE_LEN];
            uint8_t errors = 0;
            uint8_t err_pos[2] = {};
            size_t  tolerant_len = n81_decode_stream_tolerant(fifo_data, len, static_cast<size_t>(data_start),
                                                              MAX_DECODE_LEN, tolerant, &errors, err_pos, 2);

            if (tolerant_len >= 10 && tolerant_len > decoded_len) {
                int match = cca_check_crc_at_lengths(tolerant, tolerant_len, CCA_LENGTHS, N_CCA_LENGTHS);
                if (match > 0) {
                    return parse_bytes_at_length(tolerant, static_cast<size_t>(match), errors, packet);
                }
                /* N81 error recovery — brute-force corrupted bytes against CRC */
                if (errors > 0 && errors <= 2) {
                    match = cca_recover_n81_errors(tolerant, tolerant_len, CCA_LENGTHS, N_CCA_LENGTHS, err_pos, errors);
                    if (match > 0) {
                        return parse_bytes_at_length(tolerant, static_cast<size_t>(match), errors, packet);
                    }
                }
                /* Track as candidate if better than previous best */
                if (tolerant_len > best_decoded_len || (tolerant_len == best_decoded_len && errors < best_errors)) {
                    memcpy(best_decoded, tolerant, tolerant_len);
                    best_decoded_len = tolerant_len;
                    best_errors = errors;
                    memcpy(best_err_pos, err_pos, sizeof(best_err_pos));
                }
            }

            /* Position-tracked 8N1 decoder — handles clock drift */
            {
                uint8_t tracked[MAX_DECODE_LEN];
                uint8_t tracked_errors = 0;
                uint8_t tracked_err_pos[2] = {};
                size_t  tracked_len = n81_decode_stream_tracked(
                    fifo_data, len, static_cast<size_t>(data_start),
                    MAX_DECODE_LEN, tracked, &tracked_errors, tracked_err_pos, 2);
                if (tracked_len >= 10 && tracked_len > best_decoded_len) {
                    int match = cca_check_crc_at_lengths(tracked, tracked_len, CCA_LENGTHS, N_CCA_LENGTHS);
                    if (match > 0) {
                        return parse_bytes_at_length(tracked, static_cast<size_t>(match), tracked_errors, packet);
                    }
                    if (tracked_errors > 0 && tracked_errors <= 2) {
                        match = cca_recover_n81_errors(tracked, tracked_len, CCA_LENGTHS, N_CCA_LENGTHS,
                                                        tracked_err_pos, tracked_errors);
                        if (match > 0) {
                            return parse_bytes_at_length(tracked, static_cast<size_t>(match), tracked_errors, packet);
                        }
                    }
                    if (tracked_len > best_decoded_len ||
                        (tracked_len == best_decoded_len && tracked_errors < best_errors)) {
                        memcpy(best_decoded, tracked, tracked_len);
                        best_decoded_len = tracked_len;
                        best_errors = tracked_errors;
                        memcpy(best_err_pos, tracked_err_pos, sizeof(best_err_pos));
                    }
                }
            }

            if (!have_dimmer_ack && decoded_len >= 5 && decoded[0] == 0x0B) {
                if (try_parse_dimmer_ack(decoded, decoded_len, dimmer_ack)) {
                    have_dimmer_ack = true;
                }
            }

            search_from = static_cast<size_t>(data_start) + 10;
        }

        if (have_dimmer_ack) {
            packet = dimmer_ack;
            return true;
        }

        /* Last-resort recovery on best candidate before accepting as crc_valid=false */
        if (best_decoded_len >= 10) {
            if (best_errors > 0 && best_errors <= 2) {
                int match = cca_recover_n81_errors(best_decoded, best_decoded_len, CCA_LENGTHS, N_CCA_LENGTHS,
                                                   best_err_pos, best_errors);
                if (match > 0) {
                    return parse_bytes_at_length(best_decoded, static_cast<size_t>(match), best_errors, packet);
                }
            }
            /* CRC-optional fallback: accept best candidate with crc_valid=false */
            if (parse_bytes(best_decoded, best_decoded_len, packet)) {
                packet.n81_errors = best_errors;
                return true;
            }
        }

        return false;
    }

    bool parse_bytes(const uint8_t* bytes, size_t len, DecodedPacket& packet)
    {
        if (len < 10) return false;

        int match = cca_check_crc_at_lengths(bytes, len, CCA_LENGTHS, N_CCA_LENGTHS);
        if (match > 0) {
            return parse_bytes_at_length(bytes, static_cast<size_t>(match), 0, packet);
        }

        packet.clear();
        size_t copy_len = len < CCA_MAX_PACKET_LEN ? len : CCA_MAX_PACKET_LEN;
        memcpy(packet.raw, bytes, copy_len);
        packet.raw_len = copy_len;
        packet.type_byte = bytes[PKT_OFFSET_TYPE];
        packet.type = bytes[PKT_OFFSET_TYPE];
        packet.sequence = bytes[PKT_OFFSET_SEQ];
        packet.crc_valid = false;
        if (len > PKT_OFFSET_FORMAT) {
            packet.format_byte = bytes[PKT_OFFSET_FORMAT];
            packet.has_format = true;
        }
        parse_type_specific(packet, bytes, copy_len);
        packet.valid = true;
        return true;
    }

  private:
    /**
   * Try to find sync at bit 0 (fast path for CC1101-prepended data).
   * Returns data start bit offset, or -1 if sync not at expected position.
   */
    static int try_fast_sync(const uint8_t* data, size_t len)
    {
        if (len < 8) return -1;

        /* Try full FF FA DE at bit 0 */
        uint8_t b1, b2, b3;
        if (n81_decode_byte(data, len, 0, &b1) && n81_decode_byte(data, len, 10, &b2) &&
            n81_decode_byte(data, len, 20, &b3)) {
            if (b1 == 0xFF && b2 == 0xFA && b3 == 0xDE) return 30;
            if (b1 == 0xFA && b2 == 0xDE) return 20;
        }
        return -1;
    }

    /**
   * Try strict and tolerant decode at a given bit offset.
   * Returns true if a valid packet was decoded.
   */
    bool try_decode_at_offset(const uint8_t* fifo_data, size_t len, size_t data_start, DecodedPacket& packet)
    {
        uint8_t decoded[MAX_DECODE_LEN];
        size_t  decoded_len = n81_decode_stream(fifo_data, len, data_start, MAX_DECODE_LEN, decoded);

        if (decoded_len >= 10) {
            int match = cca_check_crc_at_lengths(decoded, decoded_len, CCA_LENGTHS, N_CCA_LENGTHS);
            if (match > 0) {
                return parse_bytes_at_length(decoded, static_cast<size_t>(match), 0, packet);
            }
        }

        /* Try tolerant decode */
        uint8_t tolerant[MAX_DECODE_LEN];
        uint8_t errors = 0;
        uint8_t err_pos[2] = {};
        size_t  tolerant_len =
            n81_decode_stream_tolerant(fifo_data, len, data_start, MAX_DECODE_LEN, tolerant, &errors, err_pos, 2);
        if (tolerant_len >= 10) {
            int match = cca_check_crc_at_lengths(tolerant, tolerant_len, CCA_LENGTHS, N_CCA_LENGTHS);
            if (match > 0) {
                return parse_bytes_at_length(tolerant, static_cast<size_t>(match), errors, packet);
            }
            /* N81 error recovery */
            if (errors > 0 && errors <= 2) {
                match = cca_recover_n81_errors(tolerant, tolerant_len, CCA_LENGTHS, N_CCA_LENGTHS, err_pos, errors);
                if (match > 0) {
                    return parse_bytes_at_length(tolerant, static_cast<size_t>(match), errors, packet);
                }
            }
        }

        /* Position-tracked 8N1 decoder — handles clock drift that
         * fixed-stride misses.  Matches Lutron QSM FUN_9068 approach. */
        {
            uint8_t tracked[MAX_DECODE_LEN];
            uint8_t tracked_errors = 0;
            uint8_t tracked_err_pos[2] = {};
            size_t  tracked_len = n81_decode_stream_tracked(fifo_data, len, data_start, MAX_DECODE_LEN,
                                                             tracked, &tracked_errors, tracked_err_pos, 2);
            if (tracked_len >= 10) {
                int match = cca_check_crc_at_lengths(tracked, tracked_len, CCA_LENGTHS, N_CCA_LENGTHS);
                if (match > 0) {
                    return parse_bytes_at_length(tracked, static_cast<size_t>(match), tracked_errors, packet);
                }
                if (tracked_errors > 0 && tracked_errors <= 2) {
                    match = cca_recover_n81_errors(tracked, tracked_len, CCA_LENGTHS, N_CCA_LENGTHS,
                                                    tracked_err_pos, tracked_errors);
                    if (match > 0) {
                        return parse_bytes_at_length(tracked, static_cast<size_t>(match), tracked_errors, packet);
                    }
                }
            }
        }

        /* Check for dimmer ACK */
        if (decoded_len >= 5 && decoded[0] == 0x0B) {
            return try_parse_dimmer_ack(decoded, decoded_len, packet);
        }

        /* CRC-optional fallback for fast path */
        size_t         best_len = (tolerant_len > decoded_len) ? tolerant_len : decoded_len;
        const uint8_t* best = (tolerant_len > decoded_len) ? tolerant : decoded;
        uint8_t        best_errors = (tolerant_len > decoded_len) ? errors : 0;
        if (best_len >= 10) {
            if (parse_bytes(best, best_len, packet)) {
                packet.n81_errors = best_errors;
                return true;
            }
        }

        return false;
    }

    bool parse_bytes_at_length(const uint8_t* bytes, size_t len, uint8_t n81_errors, DecodedPacket& packet)
    {
        if (len < 10) return false;

        packet.clear();
        size_t copy_len = len < CCA_MAX_PACKET_LEN ? len : CCA_MAX_PACKET_LEN;
        memcpy(packet.raw, bytes, copy_len);
        packet.raw_len = copy_len;
        packet.type_byte = bytes[PKT_OFFSET_TYPE];
        packet.type = bytes[PKT_OFFSET_TYPE];
        packet.sequence = bytes[PKT_OFFSET_SEQ];
        packet.n81_errors = n81_errors;

        size_t crc_offset = len - 2;
        packet.crc = (static_cast<uint16_t>(bytes[crc_offset]) << 8) | bytes[crc_offset + 1];
        packet.crc_valid = true;

        if (len > PKT_OFFSET_FORMAT) {
            packet.format_byte = bytes[PKT_OFFSET_FORMAT];
            packet.has_format = true;
        }

        parse_type_specific(packet, bytes, len);
        packet.valid = true;
        return true;
    }

    bool try_parse_dimmer_ack(const uint8_t* decoded, size_t decoded_len, DecodedPacket& packet)
    {
        if (decoded_len < 5 || decoded[0] != 0x0B) return false;
        if (decoded[3] != (decoded[1] ^ 0x26)) return false;

        packet.clear();
        packet.valid = true;
        packet.type_byte = 0x0B;
        packet.type = 0x0B;
        packet.sequence = decoded[1];

        uint8_t corrected_2 = decoded[2] ^ 0xFE;
        uint8_t corrected_4 = decoded[4] ^ 0xFE;

        packet.format_byte = corrected_2;
        packet.has_format = true;
        packet.level = corrected_4;
        packet.crc_valid = true;

        packet.raw[0] = 0x0B;
        packet.raw[1] = decoded[1];
        packet.raw[2] = corrected_2;
        packet.raw[3] = decoded[3];
        packet.raw[4] = corrected_4;
        packet.raw_len = 5;

        return true;
    }

    static uint32_t read_u32_be(const uint8_t* p)
    {
        return (static_cast<uint32_t>(p[0]) << 24) | (static_cast<uint32_t>(p[1]) << 16) |
               (static_cast<uint32_t>(p[2]) << 8) | static_cast<uint32_t>(p[3]);
    }

    static uint32_t read_device_id_be(const uint8_t* bytes, size_t len)
    {
        if (len < PKT_OFFSET_DEVICE_ID + 4) return 0;
        return read_u32_be(bytes + PKT_OFFSET_DEVICE_ID);
    }

    static uint32_t read_device_id_le(const uint8_t* bytes, size_t len)
    {
        if (len < PKT_OFFSET_DEVICE_ID + 4) return 0;
        const uint8_t* p = bytes + PKT_OFFSET_DEVICE_ID;
        return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) |
               (static_cast<uint32_t>(p[3]) << 24);
    }

    void parse_type_specific(DecodedPacket& packet, const uint8_t* bytes, size_t len)
    {
        uint8_t type = packet.type_byte;

        if (cca_is_button_type(type)) {
            packet.device_id = read_device_id_be(bytes, len);
            if (len > PKT_OFFSET_ACTION) {
                packet.button = bytes[PKT_OFFSET_BUTTON];
                packet.action = bytes[PKT_OFFSET_ACTION];
            }
        }
        else if (type >= 0x81 && type <= 0x83) {
            packet.device_id = read_device_id_le(bytes, len);
            uint8_t fmt = packet.has_format ? packet.format_byte : 0;

            if (fmt == QS_FMT_LEVEL) {  /* 0x0E */
                packet.type = PKT_LEVEL;
                if (len >= 18) {
                    uint16_t raw_level = (static_cast<uint16_t>(bytes[16]) << 8) | bytes[17];
                    uint32_t calc = static_cast<uint32_t>(raw_level) * 100 + 32639;
                    uint8_t  level = static_cast<uint8_t>(calc / 65279);
                    packet.level = level < 100 ? level : 100;
                }
                if (len >= 13) {
                    packet.target_id = read_u32_be(bytes + 9);
                }
            }
            else if (fmt == QS_FMT_BEACON) {  /* 0x0C: beacon / dim-stop / unpair (multi-purpose) */
                if (len >= 13) {
                    packet.target_id = read_u32_be(bytes + 9);
                }
            }
            else if (fmt == QS_FMT_CTRL) {  /* 0x09: device ctrl / hold-start / dim-stop (multi-purpose) */
                if (len >= 13) {
                    packet.target_id = read_u32_be(bytes + 9);
                }
            }
            else if (fmt == QS_FMT_STATE) {  /* 0x08 */
                if (len > PKT_OFFSET_LEVEL) {
                    uint8_t raw_level = bytes[PKT_OFFSET_LEVEL];
                    packet.level = static_cast<uint8_t>((static_cast<uint32_t>(raw_level) * 100 + 127) / 254);
                }
            }
            else if (fmt == QS_FMT_FINAL) {  /* 0x12: zone bind */
                packet.type = PKT_ZONE_BIND;
                if (len >= 13) packet.target_id = read_u32_be(bytes + 9);
            }
            else if (fmt == QS_FMT_DIM_CAP) {  /* 0x13: dimming config */
                packet.type = PKT_DIM_CONFIG;
                if (len >= 13) packet.target_id = read_u32_be(bytes + 9);
            }
            else if (fmt == QS_FMT_FUNC_MAP) {  /* 0x14: function mapping */
                packet.type = PKT_FUNC_MAP;
                if (len >= 13) packet.target_id = read_u32_be(bytes + 9);
            }
            else if (fmt == QS_FMT_TRIM) {  /* 0x15: trim / phase config */
                packet.type = PKT_TRIM_CONFIG;
                if (len >= 13) packet.target_id = read_u32_be(bytes + 9);
            }
            else if (fmt == QS_FMT_SCENE_CFG) {  /* 0x1A: scene config */
                packet.type = PKT_SCENE_CONFIG;
                if (len >= 13) packet.target_id = read_u32_be(bytes + 9);
            }
            else if (fmt == QS_FMT_FADE) {  /* 0x1C: fade config */
                packet.type = PKT_FADE_CONFIG;
                if (len >= 13) packet.target_id = read_u32_be(bytes + 9);
            }
        }
        else if (type >= 0xA1 && type <= 0xA3) {
            packet.device_id = read_device_id_le(bytes, len);
            uint8_t fmt = packet.has_format ? packet.format_byte : 0;

            if (fmt == QS_FMT_LED) {  /* 0x11 */
                packet.type = PKT_LED_CONFIG;
                if (len >= 24) packet.level = bytes[23];
                if (len >= 13) packet.target_id = read_u32_be(bytes + 9);
            }
            else if (fmt == QS_FMT_FINAL) {  /* 0x12: zone bind */
                packet.type = PKT_ZONE_BIND;
                if (len >= 13) packet.target_id = read_u32_be(bytes + 9);
            }
            else if (fmt == QS_FMT_DIM_CAP) {  /* 0x13: dimming config */
                packet.type = PKT_DIM_CONFIG;
                if (len >= 13) packet.target_id = read_u32_be(bytes + 9);
            }
            else if (fmt == QS_FMT_FUNC_MAP) {  /* 0x14: function mapping */
                packet.type = PKT_FUNC_MAP;
                if (len >= 13) packet.target_id = read_u32_be(bytes + 9);
            }
            else if (fmt == QS_FMT_TRIM) {  /* 0x15: trim / phase config */
                packet.type = PKT_TRIM_CONFIG;
                if (len >= 13) packet.target_id = read_u32_be(bytes + 9);
            }
            else if (fmt == QS_FMT_SCENE_CFG) {  /* 0x1A: scene config */
                packet.type = PKT_SCENE_CONFIG;
                if (len >= 13) packet.target_id = read_u32_be(bytes + 9);
            }
            else if (fmt == QS_FMT_FADE) {  /* 0x1C: fade config */
                packet.type = PKT_FADE_CONFIG;
                if (len >= 13) packet.target_id = read_u32_be(bytes + 9);
            }
            else if (fmt == QS_FMT_ZONE) {  /* 0x28: zone assignment (format at byte 6) */
                packet.type = PKT_ZONE_ASSIGN;
                if (len >= 18) packet.target_id = read_u32_be(bytes + 14);
            }
            else {
                packet.type = PKT_LEVEL;
                if (len >= 10) packet.level = bytes[9];
                if (len >= 14) {
                    const uint8_t* p = bytes + 10;
                    packet.target_id = static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
                                       (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
                }
            }
        }
        else if (cca_is_pairing_type(type)) {
            packet.device_id = read_device_id_be(bytes, len);
        }
        else if (type == 0xC0 || cca_is_handshake_type(type)) {
            packet.device_id = read_device_id_be(bytes, len);
        }
        else {
            packet.device_id = read_device_id_le(bytes, len);
        }
    }
};

// Static member definition
constexpr size_t CcaDecoder::CCA_LENGTHS[];
