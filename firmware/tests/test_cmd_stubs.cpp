/**
 * Firmware stub implementations for command builder unit tests.
 * Provides link-time stubs for FreeRTOS, cc1101, stream, bsp, and pairing.
 */

#include <cstdint>
#include <cstddef>

/* -----------------------------------------------------------------------
 * FreeRTOS stubs
 * ----------------------------------------------------------------------- */
extern "C" {

typedef void* QueueHandle_t;
typedef unsigned long UBaseType_t;
typedef uint32_t TickType_t;
typedef long BaseType_t;

QueueHandle_t xQueueCreate(UBaseType_t /*length*/, UBaseType_t /*item_size*/) { return nullptr; }
BaseType_t xQueueSend(QueueHandle_t /*q*/, const void* /*item*/, TickType_t /*ticks*/) { return 1; }
void vTaskDelay(TickType_t /*ticks*/) {}

/* -----------------------------------------------------------------------
 * HAL stub
 * ----------------------------------------------------------------------- */
uint32_t HAL_GetTick(void) { return 0; }

/* -----------------------------------------------------------------------
 * cc1101 stubs
 * ----------------------------------------------------------------------- */
bool cc1101_transmit_raw(const uint8_t* /*data*/, size_t /*len*/) { return true; }
void cc1101_start_rx(void) {}
void cc1101_stop_rx(void) {}
void cc1101_strobe_idle(void) {}

/* -----------------------------------------------------------------------
 * stream stubs
 * ----------------------------------------------------------------------- */
void stream_send_cca_packet(const uint8_t* /*data*/, size_t /*len*/,
                             int8_t /*rssi*/, bool /*is_tx*/, uint32_t /*ts*/) {}
void stream_task_start(void) {}
void stream_send_ccx_packet(const uint8_t* /*data*/, size_t /*len*/) {}
void stream_send_raw_frame(const uint8_t* /*data*/, size_t /*len*/) {}
void stream_broadcast_text(const char* /*text*/, size_t /*len*/) {}
bool stream_client_connected(void) { return false; }

/* -----------------------------------------------------------------------
 * bsp stubs
 * ----------------------------------------------------------------------- */
void bsp_clock_init(void) {}
void bsp_gpio_init(void) {}
void bsp_spi_init(void) {}
void bsp_uart_init(void) {}
uint32_t bsp_exti_gdo0_count(void) { return 0; }
uint32_t bsp_exti_gdo2_count(void) { return 0; }
void bsp_exti_counts_reset(void) {}

/* -----------------------------------------------------------------------
 * cca_pairing stubs
 * ----------------------------------------------------------------------- */
struct CcaCmdItem;
void cca_pairing_execute(const CcaCmdItem* /*item*/) {}

/* -----------------------------------------------------------------------
 * cca_timer stubs
 * ----------------------------------------------------------------------- */
uint32_t cca_timer_now_us(void) { return 0; }
void cca_timer_delay_ms(uint32_t /*ms*/) {}
uint32_t cca_timer_ticks(void) { return 0; }
void cca_timer_wait_until(uint32_t /*target*/) {}

/* -----------------------------------------------------------------------
 * cca_tdma stubs (used by cca_commands.cpp exec path, not builders)
 * ----------------------------------------------------------------------- */
bool cca_tdma_submit_group(const void* /*group*/) { return true; }
void cca_tdma_pause(void) {}
void cca_tdma_resume(void) {}
bool cca_tdma_is_paused(void) { return false; }
bool cca_tdma_is_idle(void) { return true; }
void cca_tdma_cancel_groups(void) {}

} /* extern "C" */
