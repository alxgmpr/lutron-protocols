//! ESPHome log file decoder

use std::path::Path;
use std::io::{BufRead, BufReader};
use std::fs::File;
use regex::Regex;
use serde::Deserialize;
use crate::error::Result;
use crate::packet::PacketType;

/// Parsed log entry
#[derive(Debug, Clone)]
pub struct LogEntry {
    pub timestamp: String,
    pub packet_type: String,
    pub device_id: String,
    pub target_id: Option<String>,
    pub level: Option<u8>,
    pub sequence: u8,
    pub rssi: i8,
    pub crc_ok: bool,
    pub raw_bytes: Vec<u8>,
    pub raw_line: String,
}

/// JSON format from ESP32 RX logs
#[derive(Debug, Deserialize)]
struct JsonRxPacket {
    bytes: String,
    rssi: i8,
    len: usize,
    crc_ok: bool,
}

/// Parse hex string like "93 01 AD 90 2C 00" into bytes
fn parse_hex_bytes(s: &str) -> Vec<u8> {
    s.split_whitespace()
        .filter_map(|hex| u8::from_str_radix(hex, 16).ok())
        .collect()
}

/// Extract packet info from raw bytes
fn extract_packet_info(bytes: &[u8]) -> (String, String, Option<String>, Option<u8>, u8) {
    if bytes.is_empty() {
        return (String::new(), String::new(), None, None, 0);
    }

    let type_byte = bytes[0];
    let pkt_type = PacketType::from_byte(type_byte);
    let packet_type = if pkt_type != PacketType::Unknown {
        pkt_type.name().to_string()
    } else {
        format!("0x{:02X}", type_byte)
    };

    let sequence = bytes.get(1).copied().unwrap_or(0);

    // Extract device ID based on packet type
    let device_id = match type_byte {
        // Beacon types - zone ID at bytes 3-4
        0x91 | 0x92 | 0x93 => {
            if bytes.len() > 4 {
                format!("{:02X}{:02X}", bytes[3], bytes[4])
            } else {
                String::new()
            }
        }
        // B0 - dimmer discovery: hardware ID at bytes 16-19
        0xB0 => {
            if bytes.len() > 19 {
                format!("{:02X}{:02X}{:02X}{:02X}", bytes[16], bytes[17], bytes[18], bytes[19])
            } else {
                String::new()
            }
        }
        // 0x80-0x8F, 0xA0-0xAF - standard packets: device ID at bytes 3-6
        _ => {
            if bytes.len() > 6 {
                format!("{:02X}{:02X}{:02X}{:02X}", bytes[3], bytes[4], bytes[5], bytes[6])
            } else {
                String::new()
            }
        }
    };

    // Extract level if present (for STATE_RPT, SET_LEVEL)
    let level = match type_byte {
        0x81 | 0x82 | 0x83 | 0xA2 => {
            // Level usually at byte 10 for state reports
            bytes.get(10).map(|&b| ((b as u16) * 100 / 255) as u8)
        }
        _ => None,
    };

    (packet_type, device_id, None, level, sequence)
}

/// Decode an ESPHome log file and extract packet entries
pub fn decode_log_file<P: AsRef<Path>>(path: P) -> Result<Vec<LogEntry>> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);

    // Regex for parsed format:
    // RX: STATE_RPT | 002C90AF | Level=100% | Seq=61 | RSSI=-44 | CRC=OK
    let rx_parsed = Regex::new(
        r"\[(\d{2}:\d{2}:\d{2}(?:\.\d{3})?)\].*RX: (\w+) \| ([0-9A-F]{8})(?:\s*->\s*([0-9A-F]{8}))?(?: \| (?:Level=(\d+)%|(\w+)\s+(\w+)))? \| Seq=(\d+) \| RSSI=(-?\d+) \| CRC=(\w+)"
    ).unwrap();

    // Regex for JSON format:
    // RX: {"bytes":"93 01 AD ...","rssi":-59,"len":24,"crc_ok":true}
    let rx_json = Regex::new(
        r"\[(\d{2}:\d{2}:\d{2}(?:\.\d{3})?)\].*RX: (\{.+\})"
    ).unwrap();

    let mut entries = Vec::new();

    for line in reader.lines() {
        let line = line?;

        // Try JSON format first (newer)
        if let Some(caps) = rx_json.captures(&line) {
            let timestamp = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
            let json_str = caps.get(2).map(|m| m.as_str()).unwrap_or("");

            if let Ok(pkt) = serde_json::from_str::<JsonRxPacket>(json_str) {
                let bytes = parse_hex_bytes(&pkt.bytes);
                let (packet_type, device_id, target_id, level, sequence) = extract_packet_info(&bytes);

                entries.push(LogEntry {
                    timestamp,
                    packet_type,
                    device_id,
                    target_id,
                    level,
                    sequence,
                    rssi: pkt.rssi,
                    crc_ok: pkt.crc_ok,
                    raw_bytes: bytes,
                    raw_line: line,
                });
            }
            continue;
        }

        // Fall back to parsed format
        if let Some(caps) = rx_parsed.captures(&line) {
            let timestamp = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
            let packet_type = caps.get(2).map(|m| m.as_str().to_string()).unwrap_or_default();
            let device_id = caps.get(3).map(|m| m.as_str().to_string()).unwrap_or_default();
            let target_id = caps.get(4).map(|m| m.as_str().to_string());
            let level = caps.get(5).and_then(|m| m.as_str().parse().ok());
            let sequence = caps.get(8).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            let rssi = caps.get(9).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            let crc_ok = caps.get(10).map(|m| m.as_str() == "OK").unwrap_or(false);

            entries.push(LogEntry {
                timestamp,
                packet_type,
                device_id,
                target_id,
                level,
                sequence,
                rssi,
                crc_ok,
                raw_bytes: Vec::new(),
                raw_line: line,
            });
        }
    }

    Ok(entries)
}

/// Summary statistics for log file
#[derive(Debug, Default)]
pub struct LogSummary {
    pub total_packets: usize,
    pub valid_crc: usize,
    pub invalid_crc: usize,
    pub packet_types: std::collections::HashMap<String, usize>,
    pub devices: std::collections::HashMap<String, usize>,
}

/// Generate summary from log entries
pub fn summarize_log(entries: &[LogEntry]) -> LogSummary {
    let mut summary = LogSummary::default();

    for entry in entries {
        summary.total_packets += 1;
        if entry.crc_ok {
            summary.valid_crc += 1;
        } else {
            summary.invalid_crc += 1;
        }

        *summary.packet_types.entry(entry.packet_type.clone()).or_insert(0) += 1;
        *summary.devices.entry(entry.device_id.clone()).or_insert(0) += 1;
    }

    summary
}
