//! ESPHome log file decoder

use std::path::Path;
use std::io::{BufRead, BufReader};
use std::fs::File;
use regex::Regex;
use crate::error::Result;

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
    pub raw_line: String,
}

/// Decode an ESPHome log file and extract packet entries
pub fn decode_log_file<P: AsRef<Path>>(path: P) -> Result<Vec<LogEntry>> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);

    // Regex patterns for different packet types
    // RX: STATE_RPT | 002C90AF | Level=100% | Seq=61 | RSSI=-44 | CRC=OK
    // RX: SET_LEVEL | 002C90AD -> FE6ADF07 | Level=7% | Seq=1 | RSSI=-59 | CRC=BAD
    // RX: BTN_SHORT_A | 0595E68D | ON PRESS | Seq=6 | RSSI=-45 | CRC=OK
    let rx_pattern = Regex::new(
        r"\[(\d{2}:\d{2}:\d{2}\.\d{3})\].*RX: (\w+) \| ([0-9A-F]{8})(?:\s*->\s*([0-9A-F]{8}))?(?: \| (?:Level=(\d+)%|(\w+)\s+(\w+)))? \| Seq=(\d+) \| RSSI=(-?\d+) \| CRC=(\w+)"
    ).unwrap();

    let mut entries = Vec::new();

    for line in reader.lines() {
        let line = line?;

        if let Some(caps) = rx_pattern.captures(&line) {
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
