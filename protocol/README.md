# CCA Protocol Definitions

This directory contains the authoritative protocol definitions for Lutron Clear Connect Type A (CCA).

## Files

- `cca.yaml` - Main protocol definition (single source of truth)

## Schema Documentation

### Structure Overview

```yaml
meta:           # Protocol metadata (name, version)
enums:          # Named lookup tables for decoded values
field_formats:  # How to decode different field types
packet_type_map: # First byte -> packet type name
packet_types:   # Full structure definitions for each packet type
device_categories: # Classification of discovered devices
```

### Field Formats

| Format | Description | Example |
|--------|-------------|---------|
| `hex` | Raw hexadecimal | `A2 00 0E` |
| `decimal` | Byte as decimal | `123` |
| `device_id` | 4-byte LE device ID | `8DE695AF` |
| `device_id_be` | 4-byte BE device ID | `AF95E68D` |
| `level_byte` | 1-byte level (0-100%) | `50%` |
| `level_16bit` | 2-byte level (0-100%) | `75%` |
| `button` | Button code (enum lookup) | `ON` |
| `action` | Action code (enum lookup) | `PRESS` |
| `crc` | 16-bit CRC | `A1B2` |

### Packet Type Categories

- **status** - State reports, acknowledgments
- **control** - Level commands, dimming
- **button** - Pico button presses
- **pairing** - Pairing and unpairing
- **unknown** - Unrecognized packets

## Code Generation

Generated code lives in `rf/generated/`:

```
rf/generated/
  typescript/protocol.ts  # Frontend type definitions
  python/cca_protocol.py  # Backend protocol module
```

To regenerate:

```bash
cca codegen
```

## Usage in Code

### Python (Backend)

```python
from generated.python.cca_protocol import (
    PACKET_TYPES,
    FIELD_FORMATS,
    ENUMS,
    get_packet_type,
    parse_field_value
)

# Get packet type from first byte
pkt_type = get_packet_type(0x88)  # -> "BTN_SHORT_A"

# Parse a field value
level = parse_field_value(bytes_list, 11, 1, "level_byte")  # -> "50%"
```

### TypeScript (Frontend)

```typescript
import {
  PacketType,
  FieldFormat,
  PACKET_TYPES,
  FIELD_FORMATS,
  getPacketType,
  parseFieldValue
} from '@/generated/protocol';

// Type-safe packet definitions
const btnFields = PACKET_TYPES.BTN.fields;

// Parse field with proper typing
const level = parseFieldValue(bytes, 11, 1, 'level_byte');
```

## Adding New Packet Types

1. Add entry to `packet_type_map` if there's a new type byte
2. Add full definition to `packet_types` with:
   - `description`
   - `category`
   - `length`
   - `device_id_endian` (if applicable)
   - `fields` array with offset/size/format for each field
3. Run `cca codegen` to regenerate code
4. Update any UI components that need to display the new type
