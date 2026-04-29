#!/usr/bin/env bash
# Builds firmware and fails on any warnings.
# Zero warnings is the contract — no allowlist, no exceptions.
#
# Speed: prefers Ninja generator + ccache when installed. ccache uses
# CCACHE_BASEDIR=<repo-root> so cache hits across worktrees with identical
# source. (OpenOCD Warn: lines only appear in 'make flash', never here.)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Pick generator + dedicated build dir. Ninja is much faster than Unix
# Makefiles for both configure and rebuild; keep it in a separate dir so
# it doesn't fight with manual `make build` (which uses Unix Makefiles).
if command -v ninja &>/dev/null; then
  GEN_FLAGS=(-G Ninja)
  BUILD_DIR="$SCRIPT_DIR/build-ninja"
else
  GEN_FLAGS=()
  BUILD_DIR="$SCRIPT_DIR/build"
fi

mkdir -p "$BUILD_DIR"

# ccache makes fresh worktrees nearly free: TUs unchanged across branches
# hit the cache. CCACHE_BASEDIR rewrites absolute paths so worktrees with
# the same code share cache entries.
CACHE_FLAGS=()
if command -v ccache &>/dev/null; then
  CACHE_FLAGS+=(-DCMAKE_C_COMPILER_LAUNCHER=ccache
                -DCMAKE_CXX_COMPILER_LAUNCHER=ccache)
  export CCACHE_BASEDIR
  CCACHE_BASEDIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

JOBS=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)

cmake_out=$(cd "$BUILD_DIR" && cmake \
    ${GEN_FLAGS[@]+"${GEN_FLAGS[@]}"} \
    -DCMAKE_BUILD_TYPE=Debug \
    ${CACHE_FLAGS[@]+"${CACHE_FLAGS[@]}"} \
    .. 2>&1)
printf '%s\n' "$cmake_out"

build_out=$(cd "$BUILD_DIR" && cmake --build . -j"$JOBS" 2>&1)
printf '%s\n' "$build_out"

warnings=$(printf '%s\n%s' "$cmake_out" "$build_out" \
    | grep -E '(warning:|CMake Warning)' || true)

if [ -n "$warnings" ]; then
    echo ""
    echo "❌ Build warnings detected:"
    printf '%s\n' "$warnings"
    exit 1
fi

if ! command -v ccache &>/dev/null; then
  echo ""
  echo "ℹ️  Tip: install ccache (\`brew install ccache\`) for ~10x faster builds on fresh worktrees."
fi

echo ""
echo "✅ Firmware build clean — no warnings"
