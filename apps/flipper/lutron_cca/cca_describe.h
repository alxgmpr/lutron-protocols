#pragma once
// Human-readable text for decoded CCA packets: list row and detail lines.
// No Flipper dependencies; host-tested in firmware/tests/test_flipper_describe.cpp.
#include <stdio.h>
#include <string.h>

#include "../../../firmware/src/cca/cca_generated.h"

#define CCA_LINE_LEN 32
#define CCA_HEX_PER_LINE 6
#define CCA_DETAIL_MAX 20 // 6 info lines + 53-byte packet / 6 per line, rounded up

inline const char* cca_action_name(uint8_t a)
{
    static const char* const names[] = {"press", "release", "hold", "save"};
    return a < 4 ? names[a] : "?";
}

inline bool cca_is_level_cmd(const DecodedPacket& p)
{
    return p.type_byte >= 0x81 && p.type_byte <= 0x83 && p.has_format && p.format_byte == QS_FMT_LEVEL;
}

// What the packet says, without the device ID. `out` should be >= 20 bytes.
inline void cca_describe_what(const DecodedPacket& p, char* out, size_t n)
{
    uint8_t t = p.type_byte;
    if (cca_is_button_type(t)) {
        const char* b = cca_button_name(p.button);
        if (b[0] == '?')
            snprintf(out, n, "btn %02X %s", p.button, cca_action_name(p.action));
        else
            snprintf(out, n, "%s %s", b, cca_action_name(p.action));
        return;
    }
    if (cca_is_level_cmd(p)) {
        snprintf(out, n, "set %u%%", p.level);
        return;
    }
    if (t >= 0x81 && t <= 0x83 && p.has_format && p.format_byte == QS_FMT_STATE) {
        snprintf(out, n, "level %u%%", p.level);
        return;
    }
    const char* name = nullptr;
    switch (p.type) { // decoder-assigned config types
    case PKT_LED_CONFIG:
        name = "LED config";
        break;
    case PKT_ZONE_BIND:
        name = "zone bind";
        break;
    case PKT_DIM_CONFIG:
        name = "dim config";
        break;
    case PKT_FUNC_MAP:
        name = "func map";
        break;
    case PKT_TRIM_CONFIG:
        name = "trim config";
        break;
    case PKT_SCENE_CONFIG:
        name = "scene config";
        break;
    case PKT_FADE_CONFIG:
        name = "fade config";
        break;
    case PKT_ZONE_ASSIGN:
        name = "zone assign";
        break;
    default:
        if (cca_is_pairing_type(t)) name = "pairing";
        break;
    }
    if (!name) name = cca_packet_type_name(t);
    if (!strcmp(name, "UNKNOWN"))
        snprintf(out, n, "type %02X", t);
    else
        snprintf(out, n, "%s", name);
}

// List filter, cycled with Left/Right.
enum { CCA_FILTER_ALL, CCA_FILTER_NO_ACK, CCA_FILTER_CONTROL, CCA_FILTER_COUNT };

inline const char* cca_filter_name(int mode)
{
    static const char* const names[] = {"All", "No ACK", "Control"};
    return names[mode];
}

// NO_ACK hides the background chatter: short ACKs (types below 0x80) and beacons.
// CONTROL keeps only button presses and level commands/reports.
inline bool cca_filter_pass(const DecodedPacket& p, int mode)
{
    uint8_t t = p.type_byte;
    if (mode == CCA_FILTER_NO_ACK) return t >= 0x80 && p.raw_len > 5 && !(t >= 0x91 && t <= 0x93);
    if (mode == CCA_FILTER_CONTROL)
        return cca_is_button_type(t) || t == 0xA2 ||
               (t >= 0x81 && t <= 0x83 && p.has_format &&
                (p.format_byte == QS_FMT_LEVEL || p.format_byte == QS_FMT_STATE));
    return true;
}

// One list row: "0595E68D ON press". Short ACKs carry no device ID.
inline void cca_describe_row(const DecodedPacket& p, char* out, size_t n)
{
    char what[20];
    cca_describe_what(p, what, sizeof(what));
    if (p.raw_len <= 5)
        snprintf(out, n, "%s", what);
    else
        snprintf(out, n, "%08lX %s", (unsigned long)p.device_id, what);
}

// Same packet resent: CCA repeats each packet with a new sequence byte (and so a new CRC).
inline bool cca_same_packet(const DecodedPacket& a, const DecodedPacket& b)
{
    return a.raw_len == b.raw_len && a.raw_len >= 5 && a.raw[0] == b.raw[0] &&
           !memcmp(a.raw + 2, b.raw + 2, a.raw_len - 4);
}

// The app's TX path only handles 24-byte packets (see cca_transmit).
inline bool cca_replayable(const DecodedPacket& p)
{
    return p.crc_valid && p.raw_len == CCA_PKT_STANDARD_LEN;
}

// Detail view lines. freqest is the CC1101 FREQEST register (LSB = 26 MHz / 2^14 = 1587 Hz).
// Returns the number of lines written.
inline int cca_detail_lines(const DecodedPacket& p, int rssi, int freqest, unsigned count, char lines[][CCA_LINE_LEN],
                            int max)
{
    int n = 0;
    auto line = [&]() { return n < max ? lines[n++] : lines[max - 1]; };
    snprintf(line(), CCA_LINE_LEN, "%s (0x%02X)", cca_packet_type_name(p.type_byte), p.type_byte);
    if (p.target_id) snprintf(line(), CCA_LINE_LEN, "Target %08lX", (unsigned long)p.target_id);
    if (cca_is_level_cmd(p) && p.raw_len > 19) {
        unsigned q = p.raw[19]; // quarter-seconds
        snprintf(line(), CCA_LINE_LEN, "Fade %u.%02us", q / 4, (q % 4) * 25);
    }
    snprintf(line(), CCA_LINE_LEN, "Seq 0x%02X  heard x%u", p.sequence, count);
    int hz100 = freqest * 1587 / 100; // units of 0.1 kHz
    int mag = hz100 < 0 ? -hz100 : hz100;
    snprintf(line(), CCA_LINE_LEN, "RSSI %ddBm", rssi);
    snprintf(line(), CCA_LINE_LEN, "Freq offset %s%d.%dkHz", hz100 < 0 ? "-" : "+", mag / 10, mag % 10);
    for (size_t i = 0; i < p.raw_len; i += CCA_HEX_PER_LINE) {
        char* l = line();
        size_t pos = 0;
        for (size_t j = i; j < i + CCA_HEX_PER_LINE && j < p.raw_len; j++)
            pos += (size_t)snprintf(l + pos, CCA_LINE_LEN - pos, j == i ? "%02X" : " %02X", p.raw[j]);
    }
    return n;
}
