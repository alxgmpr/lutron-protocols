#ifndef CCX_GENERATED_H
#define CCX_GENERATED_H

/**
 * Auto-generated from protocol/ccx.protocol.ts
 * DO NOT EDIT - regenerate with: npm run codegen
 */

/* Message type IDs */
#define CCX_MSG_LEVEL_CONTROL 0
#define CCX_MSG_BUTTON_PRESS  1
#define CCX_MSG_DIM_HOLD      2
#define CCX_MSG_DIM_STEP      3
#define CCX_MSG_ACK           7
#define CCX_MSG_DEVICE_REPORT 27
#define CCX_MSG_DEVICE_STATE  34
#define CCX_MSG_SCENE_RECALL  36
#define CCX_MSG_COMPONENT_CMD 40
#define CCX_MSG_STATUS        41
#define CCX_MSG_PRESENCE      0xFFFF

/* Body map keys */
#define CCX_KEY_COMMAND  0
#define CCX_KEY_ZONE     1
#define CCX_KEY_DEVICE   2
#define CCX_KEY_EXTRA    3
#define CCX_KEY_STATUS   4
#define CCX_KEY_SEQUENCE 5

/* Level constants */
#define CCX_LEVEL_FULL_ON 0xFEFF
#define CCX_LEVEL_OFF     0x0000

/* UDP port */
#define CCX_UDP_PORT 9190

/* Default zone type for dimmers */
#define CCX_ZONE_TYPE_DIMMER 16

#endif /* CCX_GENERATED_H */
