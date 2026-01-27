//! Live packet streaming from ESPHome logs
//!
//! Parses ESPHome log output and decodes CCA packets in real-time.
//! Expects JSON-format raw packet logs from the ESP32 controller.

use std::io::{BufRead, Write};
use std::process::{Command, Stdio, Child};
use regex::Regex;

use crate::packet::PacketParser;
use crate::error::Result;

/// Parsed packet from log stream
#[derive(Debug, Clone)]
pub struct LivePacket {
    pub timestamp: String,
    pub direction: Direction,
    pub packet_type: String,
    pub type_byte: u8,
    pub device_id: String,
    pub target_id: Option<String>,
    pub button: Option<String>,
    pub action: Option<String>,
    pub level: Option<u8>,
    pub sequence: u8,
    pub rssi: Option<i16>,
    pub crc_ok: bool,
    pub raw_bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Direction {
    Rx,
    Tx,
}

/// JSON payload from ESP32 RX log format
#[derive(Debug, serde::Deserialize)]
struct RxJsonPayload {
    bytes: String,
    rssi: i16,
    #[allow(dead_code)]
    len: usize,
    crc_ok: bool,
}

/// JSON payload from ESP32 TX log format
#[derive(Debug, serde::Deserialize)]
struct TxJsonPayload {
    bytes: String,
    #[allow(dead_code)]
    len: usize,
}

/// Live stream parser
pub struct LiveStream {
    // RX format: 02:49:08 [I] [I][lutron_cc1101:069]: RX: {"bytes":"...", "rssi":-47, ...}
    rx_pattern: Regex,
    // TX format: 02:49:08 [I] [I][lutron_cc1101:134]: TX: {"bytes":"...", "len":24}
    tx_pattern: Regex,
    parser: PacketParser,
}

impl LiveStream {
    pub fn new() -> Self {
        // RX JSON format from ESP32
        let rx_pattern = Regex::new(
            r"(\d{2}:\d{2}:\d{2}) \[.\] .*RX: (\{.+\})"
        ).unwrap();

        // TX JSON format from ESP32
        let tx_pattern = Regex::new(
            r"(\d{2}:\d{2}:\d{2}) \[.\] .*TX: (\{.+\})"
        ).unwrap();

        Self {
            rx_pattern,
            tx_pattern,
            parser: PacketParser::new(),
        }
    }

    /// Parse a single log line
    pub fn parse_line(&self, line: &str) -> Option<LivePacket> {
        // Try RX JSON format
        if let Some(caps) = self.rx_pattern.captures(line) {
            return self.parse_rx_json(caps);
        }

        // Try TX format
        if let Some(caps) = self.tx_pattern.captures(line) {
            return self.parse_tx_capture(caps);
        }

        None
    }

    /// Parse JSON-format RX line with raw packet bytes
    fn parse_rx_json(&self, caps: regex::Captures) -> Option<LivePacket> {
        let timestamp = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
        let json_str = caps.get(2).map(|m| m.as_str())?;

        // Parse the JSON payload
        let payload: RxJsonPayload = serde_json::from_str(json_str).ok()?;

        // Parse hex bytes from the JSON
        let bytes: Vec<u8> = payload.bytes
            .split_whitespace()
            .filter_map(|s| u8::from_str_radix(s, 16).ok())
            .collect();

        if bytes.is_empty() {
            return None;
        }

        // Decode the packet using our parser
        let decoded = self.parser.parse_bytes(&bytes)?;

        Some(LivePacket {
            timestamp,
            direction: Direction::Rx,
            packet_type: decoded.packet_type.name().to_string(),
            type_byte: decoded.type_byte,
            device_id: decoded.device_id_str(),
            target_id: decoded.target_id_str(),
            button: decoded.button.map(|b| b.name().to_string()),
            action: decoded.action.map(|a| a.name().to_string()),
            level: decoded.level,
            sequence: decoded.sequence,
            rssi: Some(payload.rssi),
            crc_ok: payload.crc_ok,
            raw_bytes: bytes,
        })
    }

    /// Parse JSON-format TX line with packet bytes
    fn parse_tx_capture(&self, caps: regex::Captures) -> Option<LivePacket> {
        let timestamp = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
        let json_str = caps.get(2).map(|m| m.as_str())?;

        // Parse the JSON payload
        let payload: TxJsonPayload = serde_json::from_str(json_str).ok()?;

        // Parse hex bytes from the JSON
        let bytes: Vec<u8> = payload.bytes
            .split_whitespace()
            .filter_map(|s| u8::from_str_radix(s, 16).ok())
            .collect();

        if bytes.is_empty() {
            return None;
        }

        // Decode the packet
        let decoded = self.parser.parse_bytes(&bytes)?;

        Some(LivePacket {
            timestamp,
            direction: Direction::Tx,
            packet_type: decoded.packet_type.name().to_string(),
            type_byte: decoded.type_byte,
            device_id: decoded.device_id_str(),
            target_id: decoded.target_id_str(),
            button: decoded.button.map(|b| b.name().to_string()),
            action: decoded.action.map(|a| a.name().to_string()),
            level: decoded.level,
            sequence: decoded.sequence,
            rssi: None,
            crc_ok: decoded.crc_valid,
            raw_bytes: bytes,
        })
    }

    /// Stream packets from a BufRead source
    pub fn stream_from_reader<R: BufRead, W: Write>(
        &self,
        reader: R,
        mut output: W,
        json: bool,
        show_raw: bool,
    ) -> Result<()> {
        for line in reader.lines() {
            let line = line?;
            if let Some(packet) = self.parse_line(&line) {
                if json {
                    let json_str = serde_json::to_string(&packet_to_json(&packet))?;
                    writeln!(output, "{}", json_str)?;
                } else {
                    format_packet(&packet, &mut output, show_raw)?;
                }
                output.flush()?;
            }
        }
        Ok(())
    }
}

impl Default for LiveStream {
    fn default() -> Self {
        Self::new()
    }
}

/// Spawn esphome logs process
pub fn spawn_esphome_logs(config_path: &str) -> std::io::Result<Child> {
    Command::new("esphome")
        .args(["logs", config_path])
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
}

/// Format a packet for display
pub fn format_packet<W: Write>(packet: &LivePacket, output: &mut W, show_raw: bool) -> std::io::Result<()> {
    let dir = match packet.direction {
        Direction::Rx => "RX",
        Direction::Tx => "TX",
    };

    let crc_status = if packet.crc_ok { "OK" } else { "BAD" };

    // Build the output line
    write!(output, "[{}] {} {} | {} ",
           packet.timestamp, dir, packet.packet_type, packet.device_id)?;

    if let Some(ref target) = packet.target_id {
        write!(output, "-> {} ", target)?;
    }

    if let Some(ref button) = packet.button {
        write!(output, "| {} ", button)?;
        if let Some(ref action) = packet.action {
            write!(output, "{} ", action)?;
        }
    }

    if let Some(level) = packet.level {
        write!(output, "| Level={}% ", level)?;
    }

    write!(output, "| Seq={} ", packet.sequence)?;

    if let Some(rssi) = packet.rssi {
        write!(output, "| RSSI={} ", rssi)?;
    }

    writeln!(output, "| CRC={}", crc_status)?;

    if show_raw && !packet.raw_bytes.is_empty() {
        let hex_str: String = packet.raw_bytes.iter()
            .map(|b| format!("{:02X}", b))
            .collect::<Vec<_>>()
            .join(" ");
        writeln!(output, "  Raw: {}", hex_str)?;
    }

    Ok(())
}

/// Convert packet to JSON value
fn packet_to_json(packet: &LivePacket) -> serde_json::Value {
    serde_json::json!({
        "timestamp": packet.timestamp,
        "direction": match packet.direction {
            Direction::Rx => "RX",
            Direction::Tx => "TX",
        },
        "type": packet.packet_type,
        "type_byte": format!("0x{:02X}", packet.type_byte),
        "device_id": packet.device_id,
        "target_id": packet.target_id,
        "button": packet.button,
        "action": packet.action,
        "level": packet.level,
        "sequence": packet.sequence,
        "rssi": packet.rssi,
        "crc_ok": packet.crc_ok,
        "raw": packet.raw_bytes.iter().map(|x| format!("{:02X}", x)).collect::<Vec<_>>().join(" "),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_rx_json_button_press() {
        let stream = LiveStream::new();

        let line = r#"02:49:08 [I] [I][lutron_cc1101:069]: RX: {"bytes":"88 00 08 69 E7 4C 21 04 03 00 04 00 CC CC CC CC CC CC CC CC CC CC 3A EE","rssi":-47,"len":24,"crc_ok":true}"#;
        let packet = stream.parse_line(line).unwrap();

        assert_eq!(packet.direction, Direction::Rx);
        assert_eq!(packet.timestamp, "02:49:08");
        assert_eq!(packet.packet_type, "BTN_SHORT_A");
        assert_eq!(packet.type_byte, 0x88);
        assert_eq!(packet.device_id, "0869E74C");
        assert_eq!(packet.button, Some("OFF".to_string()));
        assert_eq!(packet.action, Some("PRESS".to_string()));
        assert_eq!(packet.sequence, 0);
        assert_eq!(packet.rssi, Some(-47));
        assert!(packet.crc_ok);
        assert_eq!(packet.raw_bytes.len(), 24);
    }

    #[test]
    fn test_parse_rx_json_button_long() {
        let stream = LiveStream::new();

        let line = r#"02:49:08 [I] [I][lutron_cc1101:069]: RX: {"bytes":"89 00 08 69 E7 4C 21 0E 03 00 04 01 08 69 E7 4C 00 40 00 22 00 00 02 AD","rssi":-48,"len":24,"crc_ok":true}"#;
        let packet = stream.parse_line(line).unwrap();

        assert_eq!(packet.packet_type, "BTN_LONG_A");
        assert_eq!(packet.type_byte, 0x89);
        assert_eq!(packet.device_id, "0869E74C");
        assert_eq!(packet.rssi, Some(-48));
    }

    #[test]
    fn test_parse_rx_json_button_release() {
        let stream = LiveStream::new();

        let line = r#"02:52:21 [I] [I][lutron_cc1101:069]: RX: {"bytes":"8A 00 08 69 E7 4C 21 04 03 00 04 00 CC CC CC CC CC CC CC CC CC CC C3 EC","rssi":-45,"len":24,"crc_ok":true}"#;
        let packet = stream.parse_line(line).unwrap();

        assert_eq!(packet.packet_type, "BTN_SHORT_B");
        assert_eq!(packet.type_byte, 0x8A);
    }

    #[test]
    fn test_parse_tx_json() {
        let stream = LiveStream::new();

        let line = r#"04:30:15 [I] [I][lutron_cc1101:134]: TX: {"bytes":"88 00 08 69 E7 4C 21 04 03 00 02 00 CC CC CC CC CC CC CC CC CC CC AB CD","len":24}"#;
        let packet = stream.parse_line(line).unwrap();

        assert_eq!(packet.direction, Direction::Tx);
        assert_eq!(packet.timestamp, "04:30:15");
        assert_eq!(packet.packet_type, "BTN_SHORT_A");
        assert_eq!(packet.type_byte, 0x88);
        assert_eq!(packet.device_id, "0869E74C");
        assert_eq!(packet.button, Some("ON".to_string()));
        assert_eq!(packet.rssi, None);  // TX packets have no RSSI
        assert_eq!(packet.raw_bytes.len(), 24);
    }

    #[test]
    fn test_ignores_non_packet_lines() {
        let stream = LiveStream::new();

        assert!(stream.parse_line("02:48:56 [W] Connection stale (64s), reconnecting...").is_none());
        assert!(stream.parse_line("02:48:59 [I] Log subscription connected to ESP32").is_none());
        assert!(stream.parse_line("02:50:09 [W] Reconnecting to ESP32 in 3s...").is_none());
    }
}
