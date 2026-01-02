# Lutron CCA Protocol Constants

# RF Parameters
FREQUENCY_HZ = 433602844  # 433.602844 MHz
BAUD_RATE = 62484.7       # 62.4847 kBaud
DEVIATION_HZ = 41200      # 41.2 kHz

# Packet markers
SYNC_BYTE = 0xFF
PREFIX_BYTES = bytes([0xFA, 0xDE])

# Packet types
PACKET_TYPE_BUTTON_PRESS = 0x88

# Button codes (5-button Pico)
BUTTON_ON = 0x02
BUTTON_RAISE = 0x05
BUTTON_FAVORITE = 0x03
BUTTON_LOWER = 0x06
BUTTON_OFF = 0x04

# Alternative button codes seen in some captures
BUTTON_ON_ALT = 0x04
BUTTON_OFF_ALT = 0x08

# Action codes
ACTION_PRESS = 0x00
ACTION_RELEASE = 0x01

# CRC polynomial
CRC_POLY = 0xCA0F

# Timing
PREAMBLE_BITS = 32
TX_REPETITIONS = 6
TX_GAP_MS = 75
SEQUENCE_INCREMENT = 6

# Packet structure offsets
OFFSET_TYPE = 0
OFFSET_SEQUENCE = 1
OFFSET_DEVICE_ID = 2  # 4 bytes, little-endian
OFFSET_UNKNOWN1 = 6   # 0x21
OFFSET_UNKNOWN2 = 7   # 0x04
OFFSET_UNKNOWN3 = 8   # 0x03
OFFSET_UNKNOWN4 = 9   # 0x00
OFFSET_BUTTON = 10
OFFSET_ACTION = 11
OFFSET_PADDING = 12   # 10 bytes of 0xCC
OFFSET_CRC = 22       # 2 bytes, big-endian

PACKET_LENGTH = 24    # Total button press packet length
PAYLOAD_LENGTH = 22   # Bytes before CRC
PADDING_BYTE = 0xCC
