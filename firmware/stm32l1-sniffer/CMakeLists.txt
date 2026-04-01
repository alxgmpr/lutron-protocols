cmake_minimum_required(VERSION 3.20)

set(CMAKE_TOOLCHAIN_FILE ${CMAKE_CURRENT_SOURCE_DIR}/../cmake/arm-none-eabi.cmake)

project(stm32l1-sniffer C ASM)

set(MCU_FLAGS
    -mcpu=cortex-m3
    -mthumb
    -mfloat-abi=soft
)

set(COMMON_FLAGS
    ${MCU_FLAGS}
    -Wall -Wextra -Wno-unused-parameter
    -fdata-sections -ffunction-sections
    -Os
)

set(LINKER_SCRIPT ${CMAKE_CURRENT_SOURCE_DIR}/linker/STM32L100CB.ld)

add_executable(sniffer
    src/startup_stm32l100xb.s
    src/main.c
    src/hdlc.c
    src/semihost.c
)

target_include_directories(sniffer PRIVATE src)

target_compile_options(sniffer PRIVATE ${COMMON_FLAGS})

target_link_options(sniffer PRIVATE
    ${MCU_FLAGS}
    -T${LINKER_SCRIPT}
    --specs=nano.specs
    --specs=nosys.specs
    -Wl,--gc-sections
    -Wl,--print-memory-usage
)

# Post-build: generate .bin and .hex
add_custom_command(TARGET sniffer POST_BUILD
    COMMAND ${CMAKE_OBJCOPY} -O binary $<TARGET_FILE:sniffer> sniffer.bin
    COMMAND ${CMAKE_OBJCOPY} -O ihex $<TARGET_FILE:sniffer> sniffer.hex
    COMMAND ${CMAKE_SIZE} $<TARGET_FILE:sniffer>
    COMMENT "Generating sniffer.bin and sniffer.hex"
)
