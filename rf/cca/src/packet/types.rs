//! Packet type definitions for Lutron CCA protocol

use serde::{Deserialize, Serialize};

/// Packet type byte values
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum PacketType {
    // Button press packets (24 bytes)
    ButtonShortA = 0x88,
    ButtonLongA = 0x89,
    ButtonShortB = 0x8A,
    ButtonLongB = 0x8B,

    // State report packets (24 bytes) - format byte determines actual type
    StateReport81 = 0x81,
    StateReport82 = 0x82,
    StateReport83 = 0x83,

    // Level/config commands (24 bytes)
    Level = 0xA2,
    ConfigA3 = 0xA3,

    // Beacon packets (24 bytes)
    Beacon = 0x91,
    BeaconStop = 0x92,

    // Pairing announcements (53 bytes)
    // B9/BB: Direct-pair capable (5-button, 2-button, raise/lower)
    // BA/B8: Bridge-only (scene picos)
    PairingB8 = 0xB8,
    PairingB9 = 0xB9,
    PairingBA = 0xBA,
    PairingBB = 0xBB,
    PairingB0 = 0xB0,

    // Pairing responses from devices (24 bytes)
    PairRespC0 = 0xC0,
    PairRespC1 = 0xC1,
    PairRespC2 = 0xC2,
    PairRespC8 = 0xC8,

    // Virtual types (assigned during decode based on format byte)
    Unpair = 0xF0,
    UnpairPrep = 0xF1,
    LedConfig = 0xF2,

    // Unknown type
    Unknown = 0xFF,
}

impl PacketType {
    /// Parse type byte to PacketType enum
    pub fn from_byte(byte: u8) -> Self {
        match byte {
            0x88 => Self::ButtonShortA,
            0x89 => Self::ButtonLongA,
            0x8A => Self::ButtonShortB,
            0x8B => Self::ButtonLongB,
            0x81 => Self::StateReport81,
            0x82 => Self::StateReport82,
            0x83 => Self::StateReport83,
            0xA2 => Self::Level,
            0xA3 => Self::ConfigA3,
            0x91 => Self::Beacon,
            0x92 => Self::BeaconStop,
            0xB8 => Self::PairingB8,
            0xB9 => Self::PairingB9,
            0xBA => Self::PairingBA,
            0xBB => Self::PairingBB,
            0xB0 => Self::PairingB0,
            0xC0 => Self::PairRespC0,
            0xC1 => Self::PairRespC1,
            0xC2 => Self::PairRespC2,
            0xC8 => Self::PairRespC8,
            0xF0 => Self::Unpair,
            0xF1 => Self::UnpairPrep,
            0xF2 => Self::LedConfig,
            _ => Self::Unknown,
        }
    }

    /// Get human-readable name
    pub fn name(&self) -> &'static str {
        match self {
            Self::ButtonShortA => "BTN_SHORT_A",
            Self::ButtonLongA => "BTN_LONG_A",
            Self::ButtonShortB => "BTN_SHORT_B",
            Self::ButtonLongB => "BTN_LONG_B",
            Self::StateReport81 | Self::StateReport82 | Self::StateReport83 => "STATE_RPT",
            Self::Level => "SET_LEVEL",
            Self::ConfigA3 => "CONFIG_A3",
            Self::Beacon => "BEACON",
            Self::BeaconStop => "BEACON_STOP",
            Self::PairingB8 => "PAIR_B8",
            Self::PairingB9 => "PAIR_B9",
            Self::PairingBA => "PAIR_BA",
            Self::PairingBB => "PAIR_BB",
            Self::PairingB0 => "PAIR_B0",
            Self::PairRespC0 => "PAIR_RESP_C0",
            Self::PairRespC1 => "PAIR_RESP_C1",
            Self::PairRespC2 => "PAIR_RESP_C2",
            Self::PairRespC8 => "PAIR_RESP_C8",
            Self::Unpair => "UNPAIR",
            Self::UnpairPrep => "UNPAIR_PREP",
            Self::LedConfig => "LED_CONFIG",
            Self::Unknown => "UNKNOWN",
        }
    }

    /// Get expected packet length for this type
    pub fn expected_length(&self) -> usize {
        match self {
            Self::PairingB8 | Self::PairingB9 | Self::PairingBA | Self::PairingBB | Self::PairingB0 => 53,
            _ => 24,
        }
    }

    /// Check if this is a button press type
    pub fn is_button(&self) -> bool {
        matches!(self, Self::ButtonShortA | Self::ButtonLongA | Self::ButtonShortB | Self::ButtonLongB)
    }

    /// Check if this is a pairing announcement type
    pub fn is_pairing(&self) -> bool {
        matches!(self, Self::PairingB8 | Self::PairingB9 | Self::PairingBA | Self::PairingBB | Self::PairingB0)
    }

    /// Check if this type uses big-endian device ID
    pub fn uses_big_endian_device_id(&self) -> bool {
        self.is_button() || self.is_pairing() || matches!(self, Self::PairRespC0 | Self::PairRespC1 | Self::PairRespC2 | Self::PairRespC8)
    }
}

/// Get expected packet length from raw type byte
pub fn get_packet_length(type_byte: u8) -> Option<usize> {
    match type_byte {
        0x80..=0x8F => Some(24), // Button/state packets
        0x90..=0x9F => Some(24), // Beacons
        0xA0..=0xAF => Some(24), // Level commands
        0xB0..=0xBF => Some(53), // Pairing announcements
        0xC0..=0xCF => Some(24), // Pairing responses
        _ => None,
    }
}

/// Button codes
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Button {
    // 5-button Pico (PJ2-3BRL)
    On = 0x02,
    Favorite = 0x03,
    Off = 0x04,
    Raise = 0x05,
    Lower = 0x06,

    // 4-button Scene Pico (numbered top to bottom)
    Scene1 = 0x0B, // Top (Bright)
    Scene2 = 0x0A, // Second (Entertain)
    Scene3 = 0x09, // Third (Relax)
    Scene4 = 0x08, // Bottom (Off)

    // Special
    Reset = 0xFF,

    Unknown = 0x00,
}

impl Button {
    pub fn from_byte(byte: u8) -> Self {
        match byte {
            0x02 => Self::On,
            0x03 => Self::Favorite,
            0x04 => Self::Off,
            0x05 => Self::Raise,
            0x06 => Self::Lower,
            0x08 => Self::Scene4,
            0x09 => Self::Scene3,
            0x0A => Self::Scene2,
            0x0B => Self::Scene1,
            0xFF => Self::Reset,
            _ => Self::Unknown,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::On => "ON",
            Self::Favorite => "FAV",
            Self::Off => "OFF",
            Self::Raise => "RAISE",
            Self::Lower => "LOWER",
            Self::Scene1 => "SCENE1",
            Self::Scene2 => "SCENE2",
            Self::Scene3 => "SCENE3",
            Self::Scene4 => "SCENE4",
            Self::Reset => "RESET",
            Self::Unknown => "?",
        }
    }
}

/// Action codes
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Action {
    Press = 0x00,
    Release = 0x01,
}

impl Action {
    pub fn from_byte(byte: u8) -> Self {
        match byte {
            0x00 => Self::Press,
            0x01 => Self::Release,
            _ => Self::Press,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Press => "PRESS",
            Self::Release => "RELEASE",
        }
    }
}

/// Decoded packet structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecodedPacket {
    /// Whether packet is valid
    pub valid: bool,

    /// Packet type (may be reclassified based on format byte)
    pub packet_type: PacketType,

    /// Original type byte from wire
    pub type_byte: u8,

    /// Sequence number (0-0x47, wraps at 0x48)
    pub sequence: u8,

    /// Source device ID (32-bit)
    pub device_id: u32,

    /// Button code (for button packets)
    pub button: Option<Button>,

    /// Action (press/release)
    pub action: Option<Action>,

    /// Level (0-100 for level/state packets)
    pub level: Option<u8>,

    /// Target device ID (for bridge commands)
    pub target_id: Option<u32>,

    /// Format byte at offset 7 (determines packet subtype)
    pub format_byte: Option<u8>,

    /// CRC value from packet
    pub crc: u16,

    /// Whether CRC validated
    pub crc_valid: bool,

    /// Raw decoded bytes
    pub raw: Vec<u8>,
}

impl DecodedPacket {
    /// Create empty/invalid packet
    pub fn empty() -> Self {
        Self {
            valid: false,
            packet_type: PacketType::Unknown,
            type_byte: 0,
            sequence: 0,
            device_id: 0,
            button: None,
            action: None,
            level: None,
            target_id: None,
            format_byte: None,
            crc: 0,
            crc_valid: false,
            raw: Vec::new(),
        }
    }

    /// Format device ID as hex string (8 uppercase hex digits)
    pub fn device_id_str(&self) -> String {
        format!("{:08X}", self.device_id)
    }

    /// Format target ID as hex string (if present)
    pub fn target_id_str(&self) -> Option<String> {
        self.target_id.map(|id| format!("{:08X}", id))
    }
}

/// Packet structure offsets
pub mod offsets {
    pub const TYPE: usize = 0;
    pub const SEQUENCE: usize = 1;
    pub const DEVICE_ID: usize = 2; // 4 bytes
    pub const FORMAT: usize = 7;
    pub const BUTTON: usize = 10;
    pub const ACTION: usize = 11;
    pub const LEVEL: usize = 11;
    pub const CRC_24: usize = 22; // For 24-byte packets
    pub const CRC_53: usize = 51; // For 53-byte packets
}

/// Standard packet sizes
pub const PKT_STANDARD_LEN: usize = 24;
pub const PKT_PAIRING_LEN: usize = 53;
