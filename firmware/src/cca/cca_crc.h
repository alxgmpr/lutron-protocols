#pragma once

// CCA CRC-16 implementation (polynomial 0xCA0F)
// Ported from esphome/custom_components/cc1101_cca/cca_crc.h
// Changes: stripped esphome::cc1101_cca namespace

#include <cstdint>
#include <cstddef>

static const uint16_t CCA_CRC_POLY = 0xCA0F;

namespace detail {

struct CrcTable {
  uint16_t data[256];

  constexpr CrcTable() : data{} {
    for (int i = 0; i < 256; i++) {
      uint16_t crc = static_cast<uint16_t>(i) << 8;
      for (int j = 0; j < 8; j++) {
        if (crc & 0x8000) {
          crc = ((crc << 1) ^ CCA_CRC_POLY) & 0xFFFF;
        } else {
          crc = (crc << 1) & 0xFFFF;
        }
      }
      data[i] = crc;
    }
  }
};

static constexpr CrcTable CRC_TABLE{};

}  // namespace detail

// Calculate CRC-16 over data[0..len)
inline uint16_t cca_calc_crc(const uint8_t *data, size_t len) {
  uint16_t crc_reg = 0;
  for (size_t i = 0; i < len; i++) {
    uint8_t crc_upper = static_cast<uint8_t>(crc_reg >> 8);
    crc_reg = (((crc_reg << 8) & 0xFF00) + data[i]) ^ detail::CRC_TABLE.data[crc_upper];
  }
  return crc_reg;
}

// Check CRC at specific known packet lengths.
// Returns matching length, or -1 if no match.
inline int cca_check_crc_at_lengths(const uint8_t *bytes, size_t bytes_len,
                                    const size_t *candidates, size_t n_candidates) {
  for (size_t i = 0; i < n_candidates; i++) {
    size_t len = candidates[i];
    if (bytes_len < len || len < 4) continue;
    size_t crc_offset = len - 2;
    uint16_t computed = cca_calc_crc(bytes, crc_offset);
    uint16_t received = (static_cast<uint16_t>(bytes[crc_offset]) << 8) | bytes[crc_offset + 1];
    if (computed == received) {
      return static_cast<int>(len);
    }
  }
  return -1;
}

// Append 2-byte big-endian CRC to payload.
// output must have room for len+2 bytes.
inline void cca_append_crc(const uint8_t *payload, size_t len, uint8_t *output) {
  for (size_t i = 0; i < len; i++) output[i] = payload[i];
  uint16_t crc = cca_calc_crc(payload, len);
  output[len] = static_cast<uint8_t>(crc >> 8);
  output[len + 1] = static_cast<uint8_t>(crc & 0xFF);
}

// Compute CRC-16 continuing from a given initial state.
inline uint16_t cca_calc_crc_from(const uint8_t *data, size_t len, uint16_t init) {
  uint16_t crc_reg = init;
  for (size_t i = 0; i < len; i++) {
    uint8_t crc_upper = static_cast<uint8_t>(crc_reg >> 8);
    crc_reg = (((crc_reg << 8) & 0xFF00) + data[i]) ^ detail::CRC_TABLE.data[crc_upper];
  }
  return crc_reg;
}

// Sliding CRC: try CRC at every possible packet boundary.
// Catches non-standard lengths or alignment issues.
// Returns matching length, or -1 if no match.
inline int cca_check_crc_sliding(const uint8_t *bytes, size_t bytes_len) {
  if (bytes_len < 12) return -1;
  for (size_t len = 12; len <= bytes_len; len++) {
    size_t crc_off = len - 2;
    uint16_t computed = cca_calc_crc(bytes, crc_off);
    uint16_t received = (static_cast<uint16_t>(bytes[crc_off]) << 8) | bytes[crc_off + 1];
    if (computed == received) {
      return static_cast<int>(len);
    }
  }
  return -1;
}

// Recover N81-corrupted bytes (0xCC placeholders) via CRC brute force.
// err_pos[]: byte positions of error placeholders (from tolerant decoder).
// Modifies bytes[] in place on success (error bytes corrected, CRC fixed if needed).
// Returns matching packet length, or -1 if recovery failed.
// Supports n_errors <= 2 (256 or 65536 attempts — trivially fast on H7).
inline int cca_recover_n81_errors(uint8_t *bytes, size_t bytes_len,
                                   const size_t *candidates, size_t n_candidates,
                                   const uint8_t *err_pos, uint8_t n_errors) {
  if (n_errors == 0 || n_errors > 2) return -1;

  for (size_t ci = 0; ci < n_candidates; ci++) {
    size_t pkt_len = candidates[ci];
    if (bytes_len < pkt_len || pkt_len < 4) continue;
    size_t crc_off = pkt_len - 2;

    // Classify errors: skip out-of-bounds, split data vs CRC
    uint8_t d_pos[2], c_pos[2];
    uint8_t nd = 0, nc = 0;
    for (uint8_t e = 0; e < n_errors; e++) {
      if (err_pos[e] >= pkt_len) continue;  // beyond this candidate
      if (err_pos[e] < crc_off) d_pos[nd++] = err_pos[e];
      else c_pos[nc++] = err_pos[e];
    }
    if (nd + nc == 0) {
      // All errors outside packet — check if CRC already valid
      uint16_t computed = cca_calc_crc(bytes, crc_off);
      uint16_t received = (static_cast<uint16_t>(bytes[crc_off]) << 8) | bytes[crc_off + 1];
      if (computed == received) return static_cast<int>(pkt_len);
      continue;
    }

    if (nd == 0) {
      // All errors in CRC region — data is perfect, just recompute
      uint16_t crc = cca_calc_crc(bytes, crc_off);
      bytes[crc_off]     = static_cast<uint8_t>(crc >> 8);
      bytes[crc_off + 1] = static_cast<uint8_t>(crc & 0xFF);
      return static_cast<int>(pkt_len);
    }

    if (nd == 1 && nc == 0) {
      // 1 data error, CRC intact — brute force 256 values
      uint16_t received = (static_cast<uint16_t>(bytes[crc_off]) << 8) | bytes[crc_off + 1];
      uint8_t saved = bytes[d_pos[0]];
      for (int v = 0; v < 256; v++) {
        bytes[d_pos[0]] = static_cast<uint8_t>(v);
        if (cca_calc_crc(bytes, crc_off) == received) {
          return static_cast<int>(pkt_len);
        }
      }
      bytes[d_pos[0]] = saved;
    }

    if (nd == 1 && nc == 1) {
      // 1 data error + 1 CRC error — use the good CRC byte as 8-bit check
      bool hi_bad = (c_pos[0] == crc_off);
      uint8_t good_byte = hi_bad ? bytes[crc_off + 1] : bytes[crc_off];
      uint8_t saved = bytes[d_pos[0]];
      for (int v = 0; v < 256; v++) {
        bytes[d_pos[0]] = static_cast<uint8_t>(v);
        uint16_t computed = cca_calc_crc(bytes, crc_off);
        uint8_t check = hi_bad
            ? static_cast<uint8_t>(computed & 0xFF)
            : static_cast<uint8_t>(computed >> 8);
        if (check == good_byte) {
          // Fix CRC bytes too
          bytes[crc_off]     = static_cast<uint8_t>(computed >> 8);
          bytes[crc_off + 1] = static_cast<uint8_t>(computed & 0xFF);
          return static_cast<int>(pkt_len);
        }
      }
      bytes[d_pos[0]] = saved;
    }

    if (nd == 2 && nc == 0) {
      // 2 data errors, CRC intact — brute force 65536 combinations
      // Optimization: precompute CRC up to d_pos[1], finish inner loop from there
      uint16_t received = (static_cast<uint16_t>(bytes[crc_off]) << 8) | bytes[crc_off + 1];
      uint8_t saved0 = bytes[d_pos[0]];
      uint8_t saved1 = bytes[d_pos[1]];
      for (int v0 = 0; v0 < 256; v0++) {
        bytes[d_pos[0]] = static_cast<uint8_t>(v0);
        uint16_t partial = cca_calc_crc(bytes, d_pos[1]);
        for (int v1 = 0; v1 < 256; v1++) {
          bytes[d_pos[1]] = static_cast<uint8_t>(v1);
          if (cca_calc_crc_from(bytes + d_pos[1], crc_off - d_pos[1], partial) == received) {
            return static_cast<int>(pkt_len);
          }
        }
      }
      bytes[d_pos[0]] = saved0;
      bytes[d_pos[1]] = saved1;
    }

    // nd == 2 && nc > 0: too many unknowns for 16-bit CRC — skip
  }

  return -1;
}
