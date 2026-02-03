//! Lutron Clear Connect Type A (CCA) Protocol Library
//!
//! This library provides encoding, decoding, and analysis tools for the
//! Lutron CCA protocol used in RadioRA3, Homeworks, and Caseta systems.
//!
//! # Features
//!
//! - **CRC-16**: Custom CRC-16 with polynomial 0xCA0F
//! - **N81 Encoding**: Async serial N81 bitstream format
//! - **Packet Parsing**: Full packet structure parsing with type detection
//!
//! # no_std Support
//!
//! The core library (crc, n81, packet) supports `no_std` for embedded use.
//! Disable the `std` feature for ESP32/embedded builds.
//!
//! # Example
//!
//! ```rust
//! use cca::packet::{PacketParser, PacketType};
//!
//! let parser = PacketParser::new();
//!
//! // Parse raw packet bytes
//! let bytes = vec![0x88, 0x00, /* ... */];
//! if let Some(packet) = parser.parse_bytes(&bytes) {
//!     println!("Type: {:?}", packet.packet_type);
//!     println!("Device: {}", packet.device_id_str());
//! }
//! ```

#![cfg_attr(not(feature = "std"), no_std)]

#[cfg(not(feature = "std"))]
extern crate alloc;

// Embedded support (panic handler, allocator) for bare metal builds
#[cfg(feature = "embedded")]
mod embedded;

// Core modules (no_std compatible)
pub mod crc;
pub mod error;
pub mod ffi;
pub mod n81;
pub mod packet;

// std-only modules
#[cfg(feature = "std")]
pub mod codegen;
#[cfg(feature = "std")]
pub mod decode;
#[cfg(feature = "std")]
pub mod live;

// Re-exports for convenience
pub use crc::{append_crc, calc_crc, verify_crc};
pub use error::{CcaError, Result};
pub use packet::{Action, Button, DecodedPacket, PacketParser, PacketType};

/// Protocol constants
pub mod constants {
    /// RF frequency in Hz
    pub const FREQUENCY_HZ: u32 = 433_602_844;

    /// Baud rate
    pub const BAUD_RATE: f32 = 62_484.7;

    /// FSK deviation in Hz
    pub const DEVIATION_HZ: u32 = 41_200;

    /// CRC-16 polynomial
    pub const CRC_POLY: u16 = 0xCA0F;

    /// Sync byte
    pub const SYNC_BYTE: u8 = 0xFF;

    /// Prefix bytes
    pub const PREFIX: [u8; 2] = [0xFA, 0xDE];

    /// Standard packet length
    pub const PKT_STANDARD_LEN: usize = 24;

    /// Pairing packet length
    pub const PKT_PAIRING_LEN: usize = 53;

    /// Preamble bits
    pub const PREAMBLE_BITS: usize = 32;

    /// Sequence number increment
    pub const SEQUENCE_INCREMENT: u8 = 6;

    /// Sequence wrap value
    pub const SEQUENCE_WRAP: u8 = 0x48;
}
