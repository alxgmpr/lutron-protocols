#pragma once

// CCA packet encoder — preamble + sync + N81 + CRC
// Ported from esphome/custom_components/cc1101_cca/cca_encoder.h
// Changes: stripped esphome::cc1101_cca namespace

#include "cca_crc.h"
#include "cca_n81.h"

class CcaEncoder {
  public:
    CcaEncoder() = default;

    uint16_t calc_crc(const uint8_t* data, size_t len) { return cca_calc_crc(data, len); }

    size_t encode_packet(const uint8_t* packet, size_t packet_len, uint8_t* output, size_t output_size,
                         int preamble_bits = 32, int trailing_bits = 16)
    {
        (void)preamble_bits;
        (void)trailing_bits;
        return n81_encode_packet(packet, packet_len, output, output_size);
    }
};
