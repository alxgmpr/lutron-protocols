//! Foreign Function Interface for C/C++ and Python integration
//!
//! This module provides:
//! - C-compatible API for ESPHome and other C/C++ projects
//! - Python bindings via PyO3 (when `python` feature is enabled)

mod c_api;

#[cfg(feature = "python")]
pub mod python;

pub use c_api::*;
