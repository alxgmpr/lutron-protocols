//! Error types for CCA library

#[cfg(not(feature = "std"))]
use alloc::string::String;
#[cfg(not(feature = "std"))]
use core::result::Result as CoreResult;

use thiserror::Error;

#[derive(Error, Debug)]
pub enum CcaError {
    #[error("Invalid packet: {0}")]
    InvalidPacket(String),

    #[error("CRC mismatch: expected {expected:#06x}, got {actual:#06x}")]
    CrcMismatch { expected: u16, actual: u16 },

    #[error("Insufficient data: need {needed} bytes, got {got}")]
    InsufficientData { needed: usize, got: usize },

    #[error("N81 decode error at bit offset {offset}")]
    N81DecodeError { offset: usize },

    #[error("Unknown packet type: 0x{0:02x}")]
    UnknownPacketType(u8),

    #[cfg(feature = "std")]
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[cfg(feature = "std")]
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Parse error: {0}")]
    Parse(String),
}

#[cfg(feature = "std")]
pub type Result<T> = std::result::Result<T, CcaError>;

#[cfg(not(feature = "std"))]
pub type Result<T> = CoreResult<T, CcaError>;
