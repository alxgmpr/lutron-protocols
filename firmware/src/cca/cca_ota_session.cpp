/**
 * cca_ota_session — see cca_ota_session.h for design notes.
 */

#include "cca_ota_session.h"

#include <cstring>

static uint8_t s_body[CCA_OTA_SESSION_CAPACITY];
static uint32_t s_expected_len = 0;
static uint32_t s_body_len = 0;

extern "C" {

void cca_ota_session_reset(void)
{
    s_expected_len = 0;
    s_body_len = 0;
}

bool cca_ota_session_start(uint32_t expected_len)
{
    if (expected_len == 0) return false;
    if (expected_len > CCA_OTA_SESSION_CAPACITY) return false;
    s_expected_len = expected_len;
    s_body_len = 0;
    return true;
}

bool cca_ota_session_write(uint32_t offset, const uint8_t* data, uint32_t len)
{
    if (s_expected_len == 0) return false;
    if (data == nullptr) return false;
    /* Guard against u32 overflow before bounds checks. */
    if (offset > s_expected_len) return false;
    if (len > s_expected_len - offset) return false;
    memcpy(s_body + offset, data, len);
    uint32_t end = offset + len;
    if (end > s_body_len) s_body_len = end;
    return true;
}

uint32_t cca_ota_session_expected_len(void)
{
    return s_expected_len;
}
uint32_t cca_ota_session_body_len(void)
{
    return s_body_len;
}
bool cca_ota_session_complete(void)
{
    return s_expected_len > 0 && s_body_len == s_expected_len;
}
const uint8_t* cca_ota_session_body(void)
{
    return s_body;
}

} /* extern "C" */
