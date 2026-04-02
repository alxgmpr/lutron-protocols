/* Minimal stream stub for host-side unit tests */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

void stream_task_start(void);
void stream_send_cca_packet(const uint8_t* data, size_t len, int8_t rssi, bool is_tx, uint32_t timestamp_ms);
void stream_send_ccx_packet(const uint8_t* data, size_t len);
void stream_send_raw_frame(const uint8_t* data, size_t len);
void stream_broadcast_text(const char* text, size_t len);
bool stream_client_connected(void);

#ifdef __cplusplus
}
#endif
