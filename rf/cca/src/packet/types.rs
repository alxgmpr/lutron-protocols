//! Packet type definitions for Lutron CCA protocol

#[cfg(not(feature = "std"))]
use alloc::string::String;
#[cfg(not(feature = "std"))]
use alloc::vec::Vec;
#[cfg(not(feature = "std"))]
use alloc::format;

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
    StateReport80 = 0x80,  // Dimmer state report during pairing
    StateReport81 = 0x81,
    StateReport82 = 0x82,
    StateReport83 = 0x83,

    // Level/config commands (24 bytes)
    ConfigA1 = 0xA1,  // Configuration packet (pairing)
    Level = 0xA2,
    ConfigA3 = 0xA3,

    // Beacon packets (24 bytes)
    Beacon91 = 0x91,
    BeaconStop = 0x92,
    Beacon93 = 0x93,  // Initial pairing beacon

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

    // Handshake packets - dimmer sends odd (C1, C7, CD, D3, D9, DF), bridge sends even (C2, C8, CE, D4, DA, E0)
    // Each side increments by 6 (same as sequence byte increment)
    HandshakeC1 = 0xC1,  // Dimmer round 1
    HandshakeC2 = 0xC2,  // Bridge round 1
    HandshakeC7 = 0xC7,  // Dimmer round 2
    HandshakeC8 = 0xC8,  // Bridge round 2
    HandshakeCD = 0xCD,  // Dimmer round 3
    HandshakeCE = 0xCE,  // Bridge round 3
    HandshakeD3 = 0xD3,  // Dimmer round 4
    HandshakeD4 = 0xD4,  // Bridge round 4
    HandshakeD9 = 0xD9,  // Dimmer round 5
    HandshakeDA = 0xDA,  // Bridge round 5
    HandshakeDF = 0xDF,  // Dimmer round 6
    HandshakeE0 = 0xE0,  // Bridge round 6

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
            0x80 => Self::StateReport80,
            0x81 => Self::StateReport81,
            0x82 => Self::StateReport82,
            0x83 => Self::StateReport83,
            0x88 => Self::ButtonShortA,
            0x89 => Self::ButtonLongA,
            0x8A => Self::ButtonShortB,
            0x8B => Self::ButtonLongB,
            0x91 => Self::Beacon91,
            0x92 => Self::BeaconStop,
            0x93 => Self::Beacon93,
            0xA1 => Self::ConfigA1,
            0xA2 => Self::Level,
            0xA3 => Self::ConfigA3,
            0xB0 => Self::PairingB0,
            0xB8 => Self::PairingB8,
            0xB9 => Self::PairingB9,
            0xBA => Self::PairingBA,
            0xBB => Self::PairingBB,
            0xC0 => Self::PairRespC0,
            0xC1 => Self::HandshakeC1,
            0xC2 => Self::HandshakeC2,
            0xC7 => Self::HandshakeC7,
            0xC8 => Self::HandshakeC8,
            0xCD => Self::HandshakeCD,
            0xCE => Self::HandshakeCE,
            0xD3 => Self::HandshakeD3,
            0xD4 => Self::HandshakeD4,
            0xD9 => Self::HandshakeD9,
            0xDA => Self::HandshakeDA,
            0xDF => Self::HandshakeDF,
            0xE0 => Self::HandshakeE0,
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
            Self::StateReport80 => "STATE_80",
            Self::StateReport81 | Self::StateReport82 | Self::StateReport83 => "STATE_RPT",
            Self::ConfigA1 => "CONFIG_A1",
            Self::Level => "SET_LEVEL",
            Self::ConfigA3 => "CONFIG_A3",
            Self::Beacon91 => "BEACON_91",
            Self::BeaconStop => "BEACON_STOP",
            Self::Beacon93 => "BEACON_93",
            Self::PairingB0 => "DIMMER_DISC",
            Self::PairingB8 => "PAIR_B8",
            Self::PairingB9 => "PAIR_B9",
            Self::PairingBA => "PAIR_BA",
            Self::PairingBB => "PAIR_BB",
            Self::PairRespC0 => "PAIR_RESP_C0",
            Self::HandshakeC1 => "HS_C1",  // Dimmer handshake round 1
            Self::HandshakeC2 => "HS_C2",  // Bridge handshake round 1
            Self::HandshakeC7 => "HS_C7",  // Dimmer handshake round 2
            Self::HandshakeC8 => "HS_C8",  // Bridge handshake round 2
            Self::HandshakeCD => "HS_CD",  // Dimmer handshake round 3
            Self::HandshakeCE => "HS_CE",  // Bridge handshake round 3
            Self::HandshakeD3 => "HS_D3",  // Dimmer handshake round 4
            Self::HandshakeD4 => "HS_D4",  // Bridge handshake round 4
            Self::HandshakeD9 => "HS_D9",  // Dimmer handshake round 5
            Self::HandshakeDA => "HS_DA",  // Bridge handshake round 5
            Self::HandshakeDF => "HS_DF",  // Dimmer handshake round 6
            Self::HandshakeE0 => "HS_E0",  // Bridge handshake round 6
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
        self.is_button() || self.is_pairing() || self.is_handshake() || matches!(self, Self::PairRespC0)
    }

    /// Check if this is a handshake packet type
    pub fn is_handshake(&self) -> bool {
        matches!(self,
            Self::HandshakeC1 | Self::HandshakeC2 | Self::HandshakeC7 | Self::HandshakeC8 |
            Self::HandshakeCD | Self::HandshakeCE | Self::HandshakeD3 | Self::HandshakeD4 |
            Self::HandshakeD9 | Self::HandshakeDA | Self::HandshakeDF | Self::HandshakeE0)
    }

    /// Check if this is a dimmer handshake packet (odd types: C1, C7, CD, D3, D9, DF)
    pub fn is_dimmer_handshake(&self) -> bool {
        matches!(self,
            Self::HandshakeC1 | Self::HandshakeC7 | Self::HandshakeCD |
            Self::HandshakeD3 | Self::HandshakeD9 | Self::HandshakeDF)
    }

    /// Check if this is a bridge handshake packet (even types: C2, C8, CE, D4, DA, E0)
    pub fn is_bridge_handshake(&self) -> bool {
        matches!(self,
            Self::HandshakeC2 | Self::HandshakeC8 | Self::HandshakeCE |
            Self::HandshakeD4 | Self::HandshakeDA | Self::HandshakeE0)
    }

    /// Check if this is a beacon type
    pub fn is_beacon(&self) -> bool {
        matches!(self, Self::Beacon91 | Self::BeaconStop | Self::Beacon93)
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
