// Lutron Clear Connect Type A (CCA) transmitter for CC1101
// Based on reverse engineering from lutron_hacks repo

#include "esphome.h"
#include <SPI.h>

// CC1101 SPI Commands
#define CC1101_WRITE_SINGLE    0x00
#define CC1101_WRITE_BURST     0x40
#define CC1101_READ_SINGLE     0x80
#define CC1101_READ_BURST      0xC0

// CC1101 Strobe Commands
#define CC1101_SRES    0x30  // Reset
#define CC1101_SFSTXON 0x31  // Enable and calibrate
#define CC1101_SXOFF   0x32  // Turn off crystal
#define CC1101_SCAL    0x33  // Calibrate
#define CC1101_SRX     0x34  // Enable RX
#define CC1101_STX     0x35  // Enable TX
#define CC1101_SIDLE   0x36  // Exit RX/TX
#define CC1101_SNOP    0x3D  // No operation

// CC1101 Registers
#define CC1101_IOCFG2   0x00
#define CC1101_IOCFG1   0x01
#define CC1101_IOCFG0   0x02
#define CC1101_FIFOTHR  0x03
#define CC1101_SYNC1    0x04
#define CC1101_SYNC0    0x05
#define CC1101_PKTLEN   0x06
#define CC1101_PKTCTRL1 0x07
#define CC1101_PKTCTRL0 0x08
#define CC1101_ADDR     0x09
#define CC1101_CHANNR   0x0A
#define CC1101_FSCTRL1  0x0B
#define CC1101_FSCTRL0  0x0C
#define CC1101_FREQ2    0x0D
#define CC1101_FREQ1    0x0E
#define CC1101_FREQ0    0x0F
#define CC1101_MDMCFG4  0x10
#define CC1101_MDMCFG3  0x11
#define CC1101_MDMCFG2  0x12
#define CC1101_MDMCFG1  0x13
#define CC1101_MDMCFG0  0x14
#define CC1101_DEVIATN  0x15
#define CC1101_MCSM2    0x16
#define CC1101_MCSM1    0x17
#define CC1101_MCSM0    0x18
#define CC1101_FOCCFG   0x19
#define CC1101_BSCFG    0x1A
#define CC1101_AGCCTRL2 0x1B
#define CC1101_AGCCTRL1 0x1C
#define CC1101_AGCCTRL0 0x1D
#define CC1101_FREND1   0x21
#define CC1101_FREND0   0x22
#define CC1101_FSCAL3   0x23
#define CC1101_FSCAL2   0x24
#define CC1101_FSCAL1   0x25
#define CC1101_FSCAL0   0x26
#define CC1101_TEST2    0x2C
#define CC1101_TEST1    0x2D
#define CC1101_TEST0    0x2E
#define CC1101_PATABLE  0x3E
#define CC1101_TXFIFO   0x3F
#define CC1101_RXFIFO   0x3F

class LutronCC1101 : public Component {
 public:
  int cs_pin_;
  int gdo0_pin_;
  SPIClass *spi_;

  // CRC table for Lutron protocol
  uint16_t crc_table_[256];

  LutronCC1101(int cs_pin, int gdo0_pin) : cs_pin_(cs_pin), gdo0_pin_(gdo0_pin) {}

  void setup() override {
    pinMode(cs_pin_, OUTPUT);
    digitalWrite(cs_pin_, HIGH);

    if (gdo0_pin_ >= 0) {
      pinMode(gdo0_pin_, INPUT);
    }

    // Initialize SPI - use HSPI on ESP32
    spi_ = new SPIClass(HSPI);
    spi_->begin(14, 12, 13, cs_pin_);  // SCK, MISO, MOSI, CS

    // Generate CRC table
    generate_crc_table();

    // Initialize CC1101
    reset();
    configure_lutron();

    ESP_LOGI("lutron_cc1101", "CC1101 initialized for Lutron CCA");
  }

  void generate_crc_table() {
    for (int i = 0; i < 256; i++) {
      uint16_t crc = i << 8;
      for (int j = 0; j < 8; j++) {
        if (crc & 0x8000) {
          crc = ((crc << 1) ^ 0xca0f) & 0xffff;
        } else {
          crc = (crc << 1) & 0xffff;
        }
      }
      crc_table_[i] = crc;
    }
  }

  uint16_t calc_crc(uint8_t *data, int len) {
    uint16_t crc_reg = 0;
    for (int i = 0; i < len; i++) {
      uint8_t crc_upper = crc_reg >> 8;
      crc_reg = (((crc_reg << 8) & 0xff00) + data[i]) ^ crc_table_[crc_upper];
    }
    return crc_reg;
  }

  void spi_write(uint8_t addr, uint8_t data) {
    digitalWrite(cs_pin_, LOW);
    spi_->transfer(addr | CC1101_WRITE_SINGLE);
    spi_->transfer(data);
    digitalWrite(cs_pin_, HIGH);
  }

  uint8_t spi_read(uint8_t addr) {
    digitalWrite(cs_pin_, LOW);
    spi_->transfer(addr | CC1101_READ_SINGLE);
    uint8_t val = spi_->transfer(0);
    digitalWrite(cs_pin_, HIGH);
    return val;
  }

  void strobe(uint8_t cmd) {
    digitalWrite(cs_pin_, LOW);
    spi_->transfer(cmd);
    digitalWrite(cs_pin_, HIGH);
  }

  void reset() {
    digitalWrite(cs_pin_, HIGH);
    delayMicroseconds(5);
    digitalWrite(cs_pin_, LOW);
    delayMicroseconds(10);
    digitalWrite(cs_pin_, HIGH);
    delayMicroseconds(45);

    strobe(CC1101_SRES);
    delay(10);
  }

  void configure_lutron() {
    // Configure for Lutron CCA: 433.602844 MHz, GFSK, 62.5 kBaud
    // Based on settings from lutron_hacks repo

    strobe(CC1101_SIDLE);

    // Frequency: 433.602844 MHz
    // FREQ = 433.602844 * 2^16 / 26 = 0x10AD52
    spi_write(CC1101_FREQ2, 0x10);
    spi_write(CC1101_FREQ1, 0xAD);
    spi_write(CC1101_FREQ0, 0x52);

    // Data rate: 62.4847 kBaud
    // DRATE_E = 11, DRATE_M = 59
    spi_write(CC1101_MDMCFG4, 0x0B);
    spi_write(CC1101_MDMCFG3, 0x3B);

    // Modulation: GFSK
    spi_write(CC1101_MDMCFG2, 0x10);
    spi_write(CC1101_MDMCFG1, 0x00);
    spi_write(CC1101_MDMCFG0, 0x00);

    // Deviation: 41.2 kHz
    spi_write(CC1101_DEVIATN, 0x45);

    // Packet handling - async serial mode for custom framing
    spi_write(CC1101_PKTCTRL0, 0x32);  // Async serial mode, infinite packet length
    spi_write(CC1101_PKTCTRL1, 0x00);

    // GDO0 = sync serial data out for TX
    spi_write(CC1101_IOCFG0, 0x0C);  // Serial synchronous data output
    spi_write(CC1101_IOCFG2, 0x0B);  // Serial clock output

    // Calibration
    spi_write(CC1101_MCSM0, 0x10);  // Calibrate when going from IDLE to RX/TX

    // PA power setting
    spi_write(CC1101_FREND0, 0x10);  // Use PA_TABLE[0]

    // Set TX power (max power for +10 dBm module)
    digitalWrite(cs_pin_, LOW);
    spi_->transfer(CC1101_PATABLE | CC1101_WRITE_BURST);
    spi_->transfer(0xC0);  // +10 dBm
    digitalWrite(cs_pin_, HIGH);

    ESP_LOGI("lutron_cc1101", "CC1101 configured for 433.602844 MHz GFSK 62.5 kBaud");
  }

  // Encode a byte for Lutron's 10-bit async serial format (LSB first + "10" suffix)
  void encode_byte(uint8_t byte, uint8_t *out_bits, int *bit_pos) {
    // Start bit (0) - not needed for sync serial
    // 8 data bits LSB first
    for (int i = 0; i < 8; i++) {
      out_bits[*bit_pos / 8] |= ((byte >> i) & 1) << (*bit_pos % 8);
      (*bit_pos)++;
    }
    // Stop pattern "10"
    out_bits[*bit_pos / 8] |= 1 << (*bit_pos % 8);
    (*bit_pos)++;
    // Second bit is 0, already set by initialization
    (*bit_pos)++;
  }

  void transmit_packet(uint8_t *packet, int len) {
    // Build the full transmission:
    // 1. Preamble: alternating 1010...
    // 2. Sync byte: 0xFF
    // 3. Data bytes with 10-bit encoding

    uint8_t tx_buffer[512];
    memset(tx_buffer, 0, sizeof(tx_buffer));
    int bit_pos = 0;

    // Preamble - 32 bits of alternating pattern
    for (int i = 0; i < 32; i++) {
      if (i % 2 == 0) {
        tx_buffer[bit_pos / 8] |= 1 << (bit_pos % 8);
      }
      bit_pos++;
    }

    // Sync byte 0xFF with 10-bit encoding
    encode_byte(0xFF, tx_buffer, &bit_pos);

    // 0xFA 0xDE prefix
    encode_byte(0xFA, tx_buffer, &bit_pos);
    encode_byte(0xDE, tx_buffer, &bit_pos);

    // Data bytes
    for (int i = 0; i < len; i++) {
      encode_byte(packet[i], tx_buffer, &bit_pos);
    }

    // Trailing zeros
    bit_pos += 16;

    int byte_len = (bit_pos + 7) / 8;

    // Transmit via CC1101 FIFO
    strobe(CC1101_SIDLE);
    strobe(CC1101_SFTX);  // Flush TX FIFO

    // Write to TX FIFO
    digitalWrite(cs_pin_, LOW);
    spi_->transfer(CC1101_TXFIFO | CC1101_WRITE_BURST);
    for (int i = 0; i < byte_len && i < 64; i++) {
      spi_->transfer(tx_buffer[i]);
    }
    digitalWrite(cs_pin_, HIGH);

    // Start TX
    strobe(CC1101_STX);

    // Wait for transmission to complete
    delay(50);

    // Return to IDLE
    strobe(CC1101_SIDLE);

    ESP_LOGI("lutron_cc1101", "Transmitted %d bytes", byte_len);
  }

  // Send a Lutron button press command
  void send_button_press(uint32_t device_id, uint8_t button, uint8_t sequence) {
    uint8_t packet[24];
    memset(packet, 0xCC, sizeof(packet));  // Broadcast padding

    packet[0] = 0x88;  // Packet type for button press
    packet[1] = sequence;
    packet[2] = (device_id >> 0) & 0xFF;
    packet[3] = (device_id >> 8) & 0xFF;
    packet[4] = (device_id >> 16) & 0xFF;
    packet[5] = (device_id >> 24) & 0xFF;
    packet[6] = 0x21;
    packet[7] = 0x04;
    packet[8] = 0x03;
    packet[9] = 0x00;
    packet[10] = button;
    packet[11] = 0x00;  // Press action

    // Calculate CRC
    uint16_t crc = calc_crc(packet, 22);
    packet[22] = (crc >> 8) & 0xFF;
    packet[23] = crc & 0xFF;

    // Transmit multiple times like real Pico does
    for (int i = 0; i < 6; i++) {
      transmit_packet(packet, 24);
      packet[1] += 6;  // Increment sequence by 6

      // Recalculate CRC
      crc = calc_crc(packet, 22);
      packet[22] = (crc >> 8) & 0xFF;
      packet[23] = crc & 0xFF;

      delay(75);  // 75ms between transmissions
    }
  }
};
