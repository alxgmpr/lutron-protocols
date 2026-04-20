#!/usr/bin/env bash
# Builds firmware incrementally and fails if any warnings appear.
# Zero warnings is the contract — no allowlist, no exceptions.
# (OpenOCD Warn: lines only appear in 'make flash', never here.)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
mkdir -p "$BUILD_DIR"

cmake_out=$(cd "$BUILD_DIR" && cmake -DCMAKE_BUILD_TYPE=Debug .. 2>&1)
printf '%s\n' "$cmake_out"

build_out=$(cd "$BUILD_DIR" && cmake --build . \
    -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)" 2>&1)
printf '%s\n' "$build_out"

warnings=$(printf '%s\n%s' "$cmake_out" "$build_out" \
    | grep -E '(warning:|CMake Warning)' || true)

if [ -n "$warnings" ]; then
    echo ""
    echo "❌ Build warnings detected:"
    printf '%s\n' "$warnings"
    exit 1
fi

echo ""
echo "✅ Firmware build clean — no warnings"
