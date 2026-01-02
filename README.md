# Lutron Tools

A comprehensive toolkit for reverse engineering and extending Lutron lighting control systems.

## Features

### 1. Database Extraction (`db/`)
Extract and modify RadioRA3 and Homeworks QS project files:
- Round-trip editing of `.ra3` and `.hw` project files
- Extract embedded SQL Server databases
- Modify device configurations, scenes, and settings
- Repack modified databases into valid project files

### 2. RF Protocol Analysis (`rf/`)
Clear Connect Type A (433 MHz) protocol implementation:
- **lutron_cca/** - Python library for packet encoding/decoding
- **esphome/** - ESP32 + CC1101 hardware transmitter
- Capture, decode, and transmit Lutron RF commands
- Control Caseta/RA2 Select devices without a bridge

### 3. Designer API Proxy (`proxy/`)
Unlock Homeworks Programming features in Lutron Designer:
- Intercepts and modifies Lutron API responses
- Adds "Channels" to unlock professional features
- No Lutron dealer account required

## Quick Start

### Database Tools
```bash
# Extract a Homeworks project
python3 db/lutron-tool.py extract "project.hw" output/

# Modify the database (use SQL Server 2022 RTM)
# Then repack
python3 db/lutron-tool.py pack output/Project.mdf new.lut --template output/backup.lut
```

### RF Transmitter
```bash
# Install dependencies
pip3 install aioesphomeapi flask

# Control the ESP32 transmitter
python3 rf/esphome/esp32_controller.py list
python3 rf/esphome/esp32_controller.py press rf-on

# Start local web UI
python3 rf/esphome/esp32_controller.py serve --port 8080
```

### Designer Proxy
```bash
cd proxy
npm install
npm start  # Runs on port 3000
```

## Repository Structure

```
lutron-tools/
├── db/                     # Database extraction tools
│   ├── lutron-tool.py      # Main CLI
│   └── extract_lutron_db.py
├── rf/                     # RF/Clear Connect tools
│   ├── lutron_cca/         # Python protocol library
│   ├── esphome/            # ESP32 CC1101 component
│   └── analysis/           # Protocol analysis scripts
├── proxy/                  # Designer API proxy
│   ├── server.js
│   └── package.json
├── docs/                   # Documentation
│   ├── DATABASE_EDITING.md
│   ├── CCA_PROTOCOL.md
│   └── ...
├── research/               # Reverse engineering notes
└── data/                   # Captures, projects (gitignored)
```

## Documentation

- [Database Editing Guide](docs/DATABASE_EDITING.md) - SQL Server integration
- [Clear Connect Protocol](docs/CCA_PROTOCOL.md) - RF protocol specification
- [Packet Analysis](docs/PACKET_ANALYSIS.md) - Packet structure details
- [Known Issues](docs/KNOWN_ISSUES.md) - Current limitations
- [Quick Start](docs/QUICKSTART.md) - 5-minute tutorial

## Hardware Requirements

### RF Transmitter
- ESP32 development board
- CC1101 433MHz radio module
- Wiring: SPI connection (see `rf/esphome/pico-proxy-cc1101.yaml`)

### RF Capture
- RTL-SDR dongle for receiving/analyzing RF signals
- Works with any rtl_sdr compatible device

## Technical Details

### Database Format
Lutron project files (`.ra3`, `.hw`) are ZIP archives containing:
- `.lut` file (Microsoft Tape Format backup)
- SQL Server 2022 database (`.mdf` + `.ldf`)

### RF Protocol
- Frequency: 433.602844 MHz
- Modulation: GFSK
- Data rate: 62.5 kbaud
- Encoding: N81 serial with 0xFA 0xDE sync

## Disclaimer

This project is for educational and research purposes. Use responsibly and in accordance with applicable laws and Lutron's terms of service.

## License

MIT
