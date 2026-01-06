//! Embedded support stubs for no_std builds
//!
//! When building for bare metal (ESP32), this module provides:
//! - Panic handler
//! - Global allocator (using ESP-IDF's malloc/free)
//!
//! These are only included when building with the `embedded` feature.

use core::alloc::{GlobalAlloc, Layout};
use core::ffi::c_void;
use core::panic::PanicInfo;

extern "C" {
    fn malloc(size: usize) -> *mut c_void;
    fn free(ptr: *mut c_void);
}

/// Simple allocator that uses ESP-IDF's malloc/free
pub struct EspAllocator;

unsafe impl GlobalAlloc for EspAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        malloc(layout.size()) as *mut u8
    }

    unsafe fn dealloc(&self, ptr: *mut u8, _layout: Layout) {
        free(ptr as *mut c_void);
    }
}

#[global_allocator]
static ALLOCATOR: EspAllocator = EspAllocator;

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    // In a real embedded context, you might want to log or blink an LED
    loop {}
}
