#ifndef CCA_PAIRING_H
#define CCA_PAIRING_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

struct CcaCmdItem;
struct DecodedPacket;

/* RX hook callback type — installed during bridge pairing handshake */
typedef void (*cca_rx_hook_t)(const DecodedPacket* pkt);

/* Execute a pairing command (CCA_CMD_PICO_PAIR, CCA_CMD_BRIDGE_PAIR,
 * CCA_CMD_VIVE_PAIR, or CCA_CMD_ANNOUNCE). Called from cca_cmd_execute()
 * in CCA task context. */
void cca_pairing_execute(const CcaCmdItem* item);

#ifdef __cplusplus
}
#endif

#endif /* CCA_PAIRING_H */
