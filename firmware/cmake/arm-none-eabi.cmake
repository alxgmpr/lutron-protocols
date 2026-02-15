# CMake toolchain file for ARM Cortex-M cross-compilation
# Supports both PATH-installed and Arm GNU Toolchain .app bundle

set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR arm)

# Try to find toolchain on PATH first, then check common install locations
find_program(ARM_GCC arm-none-eabi-gcc
    PATHS
        /Applications/ArmGNUToolchain/15.2.rel1/arm-none-eabi/bin
        /Applications/ArmGNUToolchain/14.2.rel1/arm-none-eabi/bin
        /Applications/ArmGNUToolchain/13.3.rel1/arm-none-eabi/bin
        /opt/homebrew/bin
        /usr/local/bin
    NO_DEFAULT_PATH
)
if(NOT ARM_GCC)
    find_program(ARM_GCC arm-none-eabi-gcc)
endif()

if(NOT ARM_GCC)
    message(FATAL_ERROR "arm-none-eabi-gcc not found! Install with: brew install --cask gcc-arm-embedded")
endif()

get_filename_component(TOOLCHAIN_DIR ${ARM_GCC} DIRECTORY)

set(CMAKE_C_COMPILER   ${TOOLCHAIN_DIR}/arm-none-eabi-gcc)
set(CMAKE_CXX_COMPILER ${TOOLCHAIN_DIR}/arm-none-eabi-g++)
set(CMAKE_ASM_COMPILER ${TOOLCHAIN_DIR}/arm-none-eabi-gcc)
set(CMAKE_OBJCOPY      ${TOOLCHAIN_DIR}/arm-none-eabi-objcopy CACHE FILEPATH "objcopy")
set(CMAKE_OBJDUMP      ${TOOLCHAIN_DIR}/arm-none-eabi-objdump CACHE FILEPATH "objdump")
set(CMAKE_SIZE         ${TOOLCHAIN_DIR}/arm-none-eabi-size    CACHE FILEPATH "size")

set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)

# Search paths
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
