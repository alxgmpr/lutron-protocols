//! Build script for CCA library
//!
//! Generates C header file using cbindgen

use std::env;
use std::path::PathBuf;

fn main() {
    let crate_dir = env::var("CARGO_MANIFEST_DIR").unwrap();
    let header_path = PathBuf::from(&crate_dir).join("cca.h");

    // Try to generate header, but don't fail the build if it doesn't work
    // This allows building on stable Rust without macro expansion
    match cbindgen::generate(&crate_dir) {
        Ok(bindings) => {
            bindings.write_to_file(&header_path);
            println!("cargo:warning=Generated cca.h");
        }
        Err(e) => {
            println!("cargo:warning=cbindgen failed (this is OK on stable): {}", e);
        }
    }

    println!("cargo:rerun-if-changed=src/ffi/c_api.rs");
    println!("cargo:rerun-if-changed=cbindgen.toml");
}
