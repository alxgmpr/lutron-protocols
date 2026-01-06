//! Foreign Function Interface for C/C++ integration
//!
//! This module provides a C-compatible API for use with ESPHome and other
//! C/C++ projects. The API is designed to be safe and easy to use from C.

mod c_api;

pub use c_api::*;
