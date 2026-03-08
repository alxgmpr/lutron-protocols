#ifndef COAP_H
#define COAP_H

/**
 * Minimal CoAP message builder for CCX device programming.
 *
 * Builds CoAP CON (confirmable) messages with URI-Path options
 * and CBOR payloads for sending to Thread devices on port 5683.
 */

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#define COAP_PORT 5683

/* CoAP message types */
#define COAP_TYPE_CON 0
#define COAP_TYPE_NON 1
#define COAP_TYPE_ACK 2
#define COAP_TYPE_RST 3

/* CoAP method codes */
#define COAP_CODE_GET    1  /* 0.01 */
#define COAP_CODE_POST   2  /* 0.02 */
#define COAP_CODE_PUT    3  /* 0.03 */
#define COAP_CODE_DELETE 4  /* 0.04 */

/* CoAP response codes */
#define COAP_CODE_CREATED  65  /* 2.01 */
#define COAP_CODE_CHANGED  68  /* 2.04 */
#define COAP_CODE_CONTENT  69  /* 2.05 */

/* CoAP option numbers */
#define COAP_OPT_URI_PATH       11
#define COAP_OPT_CONTENT_FORMAT 12

/* Content format IDs */
#define COAP_FMT_CBOR 60

/**
 * Build a CoAP CON request with URI-Path and optional CBOR payload.
 *
 * @param buf         Output buffer
 * @param buf_size    Output buffer capacity
 * @param msg_id      CoAP message ID (for matching ACKs)
 * @param token       1-byte token
 * @param code        CoAP method code (COAP_CODE_GET/POST/PUT)
 * @param uri_path    Full URI path, e.g. "/cg/db/pr/c/00FE"
 *                    Segments split on '/' and encoded as URI-Path options
 * @param payload     CBOR payload (NULL for no payload)
 * @param payload_len Payload length
 * @return Total CoAP message length, or 0 on error
 */
size_t coap_build_request(uint8_t* buf, size_t buf_size,
                          uint16_t msg_id, uint8_t token, uint8_t code,
                          const char* uri_path,
                          const uint8_t* payload, size_t payload_len);

/**
 * Build a CoAP empty ACK (for acknowledging CON responses).
 *
 * @param buf      Output buffer (needs at least 4 bytes)
 * @param buf_size Output buffer capacity
 * @param msg_id   Message ID to acknowledge
 * @return 4 on success, 0 on error
 */
size_t coap_build_ack(uint8_t* buf, size_t buf_size, uint16_t msg_id);

/**
 * Parse a CoAP response header.
 *
 * @param buf      Input CoAP message
 * @param len      Message length
 * @param type     Output: message type (CON/NON/ACK/RST)
 * @param code     Output: response code
 * @param msg_id   Output: message ID
 * @return true if valid CoAP header parsed
 */
bool coap_parse_response(const uint8_t* buf, size_t len,
                         uint8_t* type, uint8_t* code, uint16_t* msg_id);

#ifdef __cplusplus
}
#endif

#endif /* COAP_H */
