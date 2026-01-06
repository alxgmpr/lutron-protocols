//! Auto-generated from protocol/cca.yaml
//! DO NOT EDIT - regenerate with: cca codegen
//!
//! Lutron Clear Connect Type A v1.0.0

#![allow(dead_code)]

/// RF physical layer constants
pub mod rf {
    pub const FREQUENCY_HZ: u32 = 433602844;
    pub const DEVIATION_HZ: u32 = 41200;
    pub const BAUD_RATE: f32 = 62484.7;
}

/// CRC configuration
pub mod crc {
    pub const POLYNOMIAL: u16 = 0xCA0F;
    pub const WIDTH: u8 = 16;
    pub const INITIAL: u16 = 0x0000;
}

/// Packet framing
pub mod framing {
    pub const PREAMBLE_BITS: u8 = 32;
    pub const PREAMBLE_PATTERN: u32 = 0xAAAAAAAA;
    pub const SYNC_BYTE: u8 = 0xFF;
    pub const PREFIX: [u8; 2] = [0xFA, 0xDE];
    pub const TRAILING_BITS: u8 = 16;
}

/// Timing constants (milliseconds)
pub mod timing {
    pub const BUTTON_REPEAT_MS: u32 = 70;
    pub const BEACON_INTERVAL_MS: u32 = 65;
    pub const PAIRING_INTERVAL_MS: u32 = 75;
    pub const LEVEL_REPORT_MS: u32 = 60;
    pub const UNPAIR_INTERVAL_MS: u32 = 60;
    pub const LED_CONFIG_INTERVAL_MS: u32 = 75;
}

/// Sequence number behavior
pub mod sequence {
    pub const INCREMENT: u8 = 6;
    pub const WRAP: u8 = 0x48;
}

/// Packet lengths
pub mod lengths {
    pub const STANDARD: usize = 24;
    pub const PAIRING: usize = 53;
}

/// Button action codes
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Action {
    /// Continuous hold for dimming
    Hold = 0x02,
    Press = 0x00,
    Release = 0x01,
    /// Save favorite/scene
    Save = 0x03,
}

impl Action {
    pub fn from_byte(b: u8) -> Option<Self> {
        match b {
            0x02 => Some(Self::Hold),
            0x00 => Some(Self::Press),
            0x01 => Some(Self::Release),
            0x03 => Some(Self::Save),
            _ => None,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Hold => "HOLD",
            Self::Press => "PRESS",
            Self::Release => "RELEASE",
            Self::Save => "SAVE",
        }
    }
}

/// Button code values
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Button {
    /// 5-button FAV / middle
    Favorite = 0x03,
    /// 5-button LOWER
    Lower = 0x06,
    /// 5-button OFF / bottom
    Off = 0x04,
    /// 5-button ON / top
    On = 0x02,
    /// 5-button RAISE
    Raise = 0x05,
    /// Reset/unpair
    Reset = 0xFF,
    /// 4-button top
    Scene1 = 0x0B,
    /// 4-button second
    Scene2 = 0x0A,
    /// 4-button third
    Scene3 = 0x09,
    /// 4-button bottom
    Scene4 = 0x08,
}

impl Button {
    pub fn from_byte(b: u8) -> Option<Self> {
        match b {
            0x03 => Some(Self::Favorite),
            0x06 => Some(Self::Lower),
            0x04 => Some(Self::Off),
            0x02 => Some(Self::On),
            0x05 => Some(Self::Raise),
            0xFF => Some(Self::Reset),
            0x0B => Some(Self::Scene1),
            0x0A => Some(Self::Scene2),
            0x09 => Some(Self::Scene3),
            0x08 => Some(Self::Scene4),
            _ => None,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Favorite => "FAVORITE",
            Self::Lower => "LOWER",
            Self::Off => "OFF",
            Self::On => "ON",
            Self::Raise => "RAISE",
            Self::Reset => "RESET",
            Self::Scene1 => "SCENE1",
            Self::Scene2 => "SCENE2",
            Self::Scene3 => "SCENE3",
            Self::Scene4 => "SCENE4",
        }
    }
}

/// Packet categories for filtering
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Category {
}

impl Category {
    pub fn from_byte(b: u8) -> Option<Self> {
        match b {
            _ => None,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Beacon => "BEACON",
            Self::Button => "BUTTON",
            Self::Config => "CONFIG",
            Self::Handshake => "HANDSHAKE",
            Self::Pairing => "PAIRING",
            Self::State => "STATE",
        }
    }
}

/// Device class codes (byte 28 in pairing)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum DeviceClass {
    Dimmer = 0x04,
    Fan = 0x06,
    Keypad = 0x0B,
    Shade = 0x0A,
    Switch = 0x05,
}

impl DeviceClass {
    pub fn from_byte(b: u8) -> Option<Self> {
        match b {
            0x04 => Some(Self::Dimmer),
            0x06 => Some(Self::Fan),
            0x0B => Some(Self::Keypad),
            0x0A => Some(Self::Shade),
            0x05 => Some(Self::Switch),
            _ => None,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Dimmer => "DIMMER",
            Self::Fan => "FAN",
            Self::Keypad => "KEYPAD",
            Self::Shade => "SHADE",
            Self::Switch => "SWITCH",
        }
    }
}

/// Packet type codes
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum PacketType {
    /// Pairing beacon
    Beacon = 0x91,
    /// Beacon stop
    Beacon92 = 0x92,
    /// Beacon variant
    Beacon93 = 0x93,
    /// Button press, long format, group A
    BtnLongA = 0x89,
    /// Button press, long format, group B
    BtnLongB = 0x8B,
    /// Button press, short format, group A
    BtnShortA = 0x88,
    /// Button press, short format, group B
    BtnShortB = 0x8A,
    /// LED configuration (derived from STATE_RPT format 0x0A)
    LedConfig = 0xF2,
    /// Device announcement
    PairB0 = 0xB0,
    /// Scene Pico pairing (bridge-only)
    PairB8 = 0xB8,
    /// Direct-pair Pico pairing
    PairB9 = 0xB9,
    /// Scene Pico pairing variant
    PairBa = 0xBA,
    /// Direct-pair Pico pairing variant
    PairBb = 0xBB,
    /// Pairing response
    PairRespC0 = 0xC0,
    /// Pairing response phase 1
    PairRespC1 = 0xC1,
    /// Pairing response phase 2
    PairRespC2 = 0xC2,
    /// Pairing acknowledgment
    PairRespC8 = 0xC8,
    /// Set level command
    SetLevel = 0xA2,
    /// State report (type 81)
    StateRpt81 = 0x81,
    /// State report (type 82)
    StateRpt82 = 0x82,
    /// State report (type 83)
    StateRpt83 = 0x83,
    /// Unpair command (derived from STATE_RPT format 0x0C)
    Unpair = 0xF0,
    /// Unpair preparation (derived from STATE_RPT format 0x09)
    UnpairPrep = 0xF1,
}

impl PacketType {
    pub fn from_byte(b: u8) -> Option<Self> {
        match b {
            0x91 => Some(Self::Beacon),
            0x92 => Some(Self::Beacon92),
            0x93 => Some(Self::Beacon93),
            0x89 => Some(Self::BtnLongA),
            0x8B => Some(Self::BtnLongB),
            0x88 => Some(Self::BtnShortA),
            0x8A => Some(Self::BtnShortB),
            0xF2 => Some(Self::LedConfig),
            0xB0 => Some(Self::PairB0),
            0xB8 => Some(Self::PairB8),
            0xB9 => Some(Self::PairB9),
            0xBA => Some(Self::PairBa),
            0xBB => Some(Self::PairBb),
            0xC0 => Some(Self::PairRespC0),
            0xC1 => Some(Self::PairRespC1),
            0xC2 => Some(Self::PairRespC2),
            0xC8 => Some(Self::PairRespC8),
            0xA2 => Some(Self::SetLevel),
            0x81 => Some(Self::StateRpt81),
            0x82 => Some(Self::StateRpt82),
            0x83 => Some(Self::StateRpt83),
            0xF0 => Some(Self::Unpair),
            0xF1 => Some(Self::UnpairPrep),
            _ => None,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Beacon => "BEACON",
            Self::Beacon92 => "BEACON_92",
            Self::Beacon93 => "BEACON_93",
            Self::BtnLongA => "BTN_LONG_A",
            Self::BtnLongB => "BTN_LONG_B",
            Self::BtnShortA => "BTN_SHORT_A",
            Self::BtnShortB => "BTN_SHORT_B",
            Self::LedConfig => "LED_CONFIG",
            Self::PairB0 => "PAIR_B0",
            Self::PairB8 => "PAIR_B8",
            Self::PairB9 => "PAIR_B9",
            Self::PairBa => "PAIR_BA",
            Self::PairBb => "PAIR_BB",
            Self::PairRespC0 => "PAIR_RESP_C0",
            Self::PairRespC1 => "PAIR_RESP_C1",
            Self::PairRespC2 => "PAIR_RESP_C2",
            Self::PairRespC8 => "PAIR_RESP_C8",
            Self::SetLevel => "SET_LEVEL",
            Self::StateRpt81 => "STATE_RPT_81",
            Self::StateRpt82 => "STATE_RPT_82",
            Self::StateRpt83 => "STATE_RPT_83",
            Self::Unpair => "UNPAIR",
            Self::UnpairPrep => "UNPAIR_PREP",
        }
    }

    pub fn expected_length(&self) -> usize {
        match self {
            Self::Beacon => 24,
            Self::Beacon92 => 24,
            Self::Beacon93 => 24,
            Self::BtnLongA => 24,
            Self::BtnLongB => 24,
            Self::BtnShortA => 24,
            Self::BtnShortB => 24,
            Self::LedConfig => 24,
            Self::PairB0 => 53,
            Self::PairB8 => 53,
            Self::PairB9 => 53,
            Self::PairBa => 53,
            Self::PairBb => 53,
            Self::PairRespC0 => 24,
            Self::PairRespC1 => 24,
            Self::PairRespC2 => 24,
            Self::PairRespC8 => 24,
            Self::SetLevel => 24,
            Self::StateRpt81 => 24,
            Self::StateRpt82 => 24,
            Self::StateRpt83 => 24,
            Self::Unpair => 24,
            Self::UnpairPrep => 24,
        }
    }

    pub fn category(&self) -> &'static str {
        match self {
            Self::Beacon => "BEACON",
            Self::Beacon92 => "BEACON",
            Self::Beacon93 => "BEACON",
            Self::BtnLongA => "BUTTON",
            Self::BtnLongB => "BUTTON",
            Self::BtnShortA => "BUTTON",
            Self::BtnShortB => "BUTTON",
            Self::LedConfig => "CONFIG",
            Self::PairB0 => "PAIRING",
            Self::PairB8 => "PAIRING",
            Self::PairB9 => "PAIRING",
            Self::PairBa => "PAIRING",
            Self::PairBb => "PAIRING",
            Self::PairRespC0 => "HANDSHAKE",
            Self::PairRespC1 => "HANDSHAKE",
            Self::PairRespC2 => "HANDSHAKE",
            Self::PairRespC8 => "HANDSHAKE",
            Self::SetLevel => "CONFIG",
            Self::StateRpt81 => "STATE",
            Self::StateRpt82 => "STATE",
            Self::StateRpt83 => "STATE",
            Self::Unpair => "CONFIG",
            Self::UnpairPrep => "CONFIG",
        }
    }

    pub fn uses_big_endian_device_id(&self) -> bool {
        match self {
            Self::Beacon => true,
            Self::Beacon92 => true,
            Self::Beacon93 => true,
            Self::BtnLongA => true,
            Self::BtnLongB => true,
            Self::BtnShortA => true,
            Self::BtnShortB => true,
            Self::LedConfig => false,
            Self::PairB0 => true,
            Self::PairB8 => true,
            Self::PairB9 => true,
            Self::PairBa => true,
            Self::PairBb => true,
            Self::PairRespC0 => true,
            Self::PairRespC1 => true,
            Self::PairRespC2 => true,
            Self::PairRespC8 => true,
            Self::SetLevel => false,
            Self::StateRpt81 => false,
            Self::StateRpt82 => false,
            Self::StateRpt83 => false,
            Self::Unpair => false,
            Self::UnpairPrep => false,
        }
    }

    pub fn is_virtual(&self) -> bool {
        match self {
            _ => false,
        }
    }
}

/// Field definition for packet parsing
#[derive(Debug, Clone)]
pub struct FieldDef {
    pub name: &'static str,
    pub offset: usize,
    pub size: usize,
    pub format: FieldFormat,
}

/// Field format types
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldFormat {
    Hex,
    Decimal,
    DeviceId,
    DeviceIdBe,
    LevelByte,
    Level16bit,
    Button,
    Action,
}

/// Packet field definitions
pub mod fields {
    use super::{FieldDef, FieldFormat};

    pub const BEACON: &[FieldDef] = &[
        FieldDef { name: "type", offset: 0, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "sequence", offset: 1, size: 1, format: FieldFormat::Decimal },
        FieldDef { name: "load_id", offset: 2, size: 4, format: FieldFormat::DeviceIdBe },
        FieldDef { name: "protocol", offset: 6, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "format", offset: 7, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "fixed", offset: 8, size: 5, format: FieldFormat::Hex },
        FieldDef { name: "broadcast", offset: 13, size: 9, format: FieldFormat::Hex },
        FieldDef { name: "crc", offset: 22, size: 2, format: FieldFormat::Hex },
    ];

    pub const BTN_LONG_A: &[FieldDef] = &[
        FieldDef { name: "type", offset: 0, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "sequence", offset: 1, size: 1, format: FieldFormat::Decimal },
        FieldDef { name: "device_id", offset: 2, size: 4, format: FieldFormat::DeviceIdBe },
        FieldDef { name: "protocol", offset: 6, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "format", offset: 7, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "fixed", offset: 8, size: 2, format: FieldFormat::Hex },
        FieldDef { name: "button", offset: 10, size: 1, format: FieldFormat::Button },
        FieldDef { name: "action", offset: 11, size: 1, format: FieldFormat::Action },
        FieldDef { name: "device_repeat", offset: 12, size: 4, format: FieldFormat::DeviceIdBe },
        FieldDef { name: "button_data", offset: 16, size: 6, format: FieldFormat::Hex },
        FieldDef { name: "crc", offset: 22, size: 2, format: FieldFormat::Hex },
    ];

    pub const BTN_SHORT_A: &[FieldDef] = &[
        FieldDef { name: "type", offset: 0, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "sequence", offset: 1, size: 1, format: FieldFormat::Decimal },
        FieldDef { name: "device_id", offset: 2, size: 4, format: FieldFormat::DeviceIdBe },
        FieldDef { name: "protocol", offset: 6, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "format", offset: 7, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "fixed", offset: 8, size: 2, format: FieldFormat::Hex },
        FieldDef { name: "button", offset: 10, size: 1, format: FieldFormat::Button },
        FieldDef { name: "action", offset: 11, size: 1, format: FieldFormat::Action },
        FieldDef { name: "padding", offset: 12, size: 10, format: FieldFormat::Hex },
        FieldDef { name: "crc", offset: 22, size: 2, format: FieldFormat::Hex },
    ];

    pub const PAIR_B0: &[FieldDef] = &[
        FieldDef { name: "type", offset: 0, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "sequence", offset: 1, size: 1, format: FieldFormat::Decimal },
        FieldDef { name: "device_id", offset: 2, size: 4, format: FieldFormat::DeviceIdBe },
        FieldDef { name: "protocol", offset: 6, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "format", offset: 7, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "data", offset: 8, size: 43, format: FieldFormat::Hex },
        FieldDef { name: "crc", offset: 51, size: 2, format: FieldFormat::Hex },
    ];

    pub const PAIR_B8: &[FieldDef] = &[
        FieldDef { name: "type", offset: 0, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "sequence", offset: 1, size: 1, format: FieldFormat::Decimal },
        FieldDef { name: "device_id", offset: 2, size: 4, format: FieldFormat::DeviceIdBe },
        FieldDef { name: "protocol", offset: 6, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "format", offset: 7, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "fixed", offset: 8, size: 2, format: FieldFormat::Hex },
        FieldDef { name: "btn_scheme", offset: 10, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "fixed2", offset: 11, size: 2, format: FieldFormat::Hex },
        FieldDef { name: "broadcast", offset: 13, size: 5, format: FieldFormat::Hex },
        FieldDef { name: "fixed3", offset: 18, size: 2, format: FieldFormat::Hex },
        FieldDef { name: "device_id2", offset: 20, size: 4, format: FieldFormat::DeviceIdBe },
        FieldDef { name: "device_id3", offset: 24, size: 4, format: FieldFormat::DeviceIdBe },
        FieldDef { name: "device_class", offset: 28, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "device_sub", offset: 29, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "caps", offset: 30, size: 11, format: FieldFormat::Hex },
        FieldDef { name: "broadcast2", offset: 41, size: 4, format: FieldFormat::Hex },
        FieldDef { name: "padding", offset: 45, size: 6, format: FieldFormat::Hex },
        FieldDef { name: "crc", offset: 51, size: 2, format: FieldFormat::Hex },
    ];

    pub const PAIR_RESP_C0: &[FieldDef] = &[
        FieldDef { name: "type", offset: 0, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "sequence", offset: 1, size: 1, format: FieldFormat::Decimal },
        FieldDef { name: "device_id", offset: 2, size: 4, format: FieldFormat::DeviceIdBe },
        FieldDef { name: "protocol", offset: 6, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "format", offset: 7, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "data", offset: 8, size: 14, format: FieldFormat::Hex },
        FieldDef { name: "crc", offset: 22, size: 2, format: FieldFormat::Hex },
    ];

    pub const SET_LEVEL: &[FieldDef] = &[
        FieldDef { name: "type", offset: 0, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "sequence", offset: 1, size: 1, format: FieldFormat::Decimal },
        FieldDef { name: "source_id", offset: 2, size: 4, format: FieldFormat::DeviceId },
        FieldDef { name: "protocol", offset: 6, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "format", offset: 7, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "fixed", offset: 8, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "target_id", offset: 9, size: 4, format: FieldFormat::DeviceIdBe },
        FieldDef { name: "fixed2", offset: 13, size: 3, format: FieldFormat::Hex },
        FieldDef { name: "level", offset: 16, size: 2, format: FieldFormat::Level16bit },
        FieldDef { name: "padding", offset: 18, size: 4, format: FieldFormat::Hex },
        FieldDef { name: "crc", offset: 22, size: 2, format: FieldFormat::Hex },
    ];

    pub const STATE_RPT_81: &[FieldDef] = &[
        FieldDef { name: "type", offset: 0, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "sequence", offset: 1, size: 1, format: FieldFormat::Decimal },
        FieldDef { name: "device_id", offset: 2, size: 4, format: FieldFormat::DeviceId },
        FieldDef { name: "protocol", offset: 6, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "format", offset: 7, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "fixed", offset: 8, size: 3, format: FieldFormat::Hex },
        FieldDef { name: "level", offset: 11, size: 1, format: FieldFormat::LevelByte },
        FieldDef { name: "padding", offset: 12, size: 10, format: FieldFormat::Hex },
        FieldDef { name: "crc", offset: 22, size: 2, format: FieldFormat::Hex },
    ];

    pub const UNPAIR: &[FieldDef] = &[
        FieldDef { name: "type", offset: 0, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "sequence", offset: 1, size: 1, format: FieldFormat::Decimal },
        FieldDef { name: "source_id", offset: 2, size: 4, format: FieldFormat::DeviceId },
        FieldDef { name: "protocol", offset: 6, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "format", offset: 7, size: 1, format: FieldFormat::Hex },
        FieldDef { name: "fixed", offset: 8, size: 3, format: FieldFormat::Hex },
        FieldDef { name: "command", offset: 11, size: 5, format: FieldFormat::Hex },
        FieldDef { name: "target_id", offset: 16, size: 4, format: FieldFormat::DeviceIdBe },
        FieldDef { name: "padding", offset: 20, size: 2, format: FieldFormat::Hex },
        FieldDef { name: "crc", offset: 22, size: 2, format: FieldFormat::Hex },
    ];

}

/// Transmission sequence definitions
pub mod sequences {
    use super::PacketType;

    /// A step in a transmission sequence
    #[derive(Debug, Clone)]
    pub struct Step {
        pub packet_type: PacketType,
        pub count: Option<u32>,  // None = repeat until stopped
        pub interval_ms: u32,
    }

    /// Sequence definition
    #[derive(Debug, Clone)]
    pub struct Sequence {
        pub name: &'static str,
        pub description: &'static str,
        pub steps: &'static [Step],
    }

    /// Dimming hold (raise/lower)
    pub const BUTTON_HOLD_STEPS: &[Step] = &[
        Step { packet_type: PacketType::BtnShortA, count: None, interval_ms: 65 },
    ];

    pub const BUTTON_HOLD: Sequence = Sequence {
        name: "button_hold",
        description: "Dimming hold (raise/lower)",
        steps: BUTTON_HOLD_STEPS,
    };

    /// Standard 5-button Pico press
    pub const BUTTON_PRESS_STEPS: &[Step] = &[
        Step { packet_type: PacketType::BtnShortA, count: Some(3), interval_ms: 70 },
        Step { packet_type: PacketType::BtnLongA, count: Some(1), interval_ms: 70 },
    ];

    pub const BUTTON_PRESS: Sequence = Sequence {
        name: "button_press",
        description: "Standard 5-button Pico press",
        steps: BUTTON_PRESS_STEPS,
    };

    /// Button release (sent after press)
    pub const BUTTON_RELEASE_STEPS: &[Step] = &[
        Step { packet_type: PacketType::BtnShortB, count: Some(3), interval_ms: 70 },
        Step { packet_type: PacketType::BtnLongB, count: Some(1), interval_ms: 70 },
    ];

    pub const BUTTON_RELEASE: Sequence = Sequence {
        name: "button_release",
        description: "Button release (sent after press)",
        steps: BUTTON_RELEASE_STEPS,
    };

    /// Pairing beacon broadcast
    pub const PAIRING_BEACON_STEPS: &[Step] = &[
        Step { packet_type: PacketType::Beacon, count: None, interval_ms: 65 },
    ];

    pub const PAIRING_BEACON: Sequence = Sequence {
        name: "pairing_beacon",
        description: "Pairing beacon broadcast",
        steps: PAIRING_BEACON_STEPS,
    };

    /// Pico pairing announcement
    pub const PICO_PAIRING_STEPS: &[Step] = &[
        Step { packet_type: PacketType::PairB9, count: Some(15), interval_ms: 75 },
    ];

    pub const PICO_PAIRING: Sequence = Sequence {
        name: "pico_pairing",
        description: "Pico pairing announcement",
        steps: PICO_PAIRING_STEPS,
    };

    /// Set dimmer level
    pub const SET_LEVEL_STEPS: &[Step] = &[
        Step { packet_type: PacketType::SetLevel, count: Some(20), interval_ms: 60 },
    ];

    pub const SET_LEVEL: Sequence = Sequence {
        name: "set_level",
        description: "Set dimmer level",
        steps: SET_LEVEL_STEPS,
    };

    /// Unpair device from bridge
    pub const UNPAIR_STEPS: &[Step] = &[
        Step { packet_type: PacketType::Unpair, count: Some(20), interval_ms: 60 },
    ];

    pub const UNPAIR: Sequence = Sequence {
        name: "unpair",
        description: "Unpair device from bridge",
        steps: UNPAIR_STEPS,
    };

}
