cmake_minimum_required(VERSION 3.22)

# ------------------------------------------------------------------
# Toolchain must be set before project()
# ------------------------------------------------------------------
set(CMAKE_TOOLCHAIN_FILE ${CMAKE_CURRENT_SOURCE_DIR}/cmake/arm-none-eabi.cmake)

project(nucleo-firmware C CXX ASM)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ------------------------------------------------------------------
# MCU flags (Cortex-M7 with double-precision FPU)
# ------------------------------------------------------------------
set(MCU_FLAGS "-mcpu=cortex-m7 -mthumb -mfpu=fpv5-d16 -mfloat-abi=hard")
set(CMAKE_C_FLAGS   "${CMAKE_C_FLAGS}   ${MCU_FLAGS} -Wall -Wextra -fdata-sections -ffunction-sections")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${MCU_FLAGS} -Wall -Wextra -fdata-sections -ffunction-sections -fno-exceptions -fno-rtti")
set(CMAKE_ASM_FLAGS "${CMAKE_ASM_FLAGS} ${MCU_FLAGS}")

# ------------------------------------------------------------------
# FetchContent: STM32CubeH7 (sources only) and FreeRTOS-Kernel
# ------------------------------------------------------------------
include(FetchContent)

# STM32CubeH7 — no top-level CMakeLists.txt, just download sources
FetchContent_Declare(
    stm32cubeh7
    GIT_REPOSITORY https://github.com/STMicroelectronics/STM32CubeH7.git
    GIT_TAG        v1.11.2
    GIT_SHALLOW    TRUE
    GIT_PROGRESS   TRUE
)

# FreeRTOS-Kernel — has CMakeLists.txt but needs config target first
FetchContent_Declare(
    freertos
    GIT_REPOSITORY https://github.com/FreeRTOS/FreeRTOS-Kernel.git
    GIT_TAG        V11.1.0
    GIT_SHALLOW    TRUE
    GIT_PROGRESS   TRUE
)

# Download STM32CubeH7 (populate only, no add_subdirectory)
FetchContent_GetProperties(stm32cubeh7)
if(NOT stm32cubeh7_POPULATED)
    FetchContent_Populate(stm32cubeh7)
endif()

# Set up FreeRTOS config target BEFORE making it available
FetchContent_GetProperties(freertos)
if(NOT freertos_POPULATED)
    FetchContent_Populate(freertos)
endif()

# Create the freertos_config interface target that FreeRTOS-Kernel requires
add_library(freertos_config INTERFACE)
target_include_directories(freertos_config SYSTEM INTERFACE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_compile_definitions(freertos_config INTERFACE
    projCOVERAGE_TEST=0
)

# Set the FreeRTOS port and heap implementation
set(FREERTOS_PORT "GCC_ARM_CM7" CACHE STRING "FreeRTOS port")
set(FREERTOS_HEAP "4" CACHE STRING "FreeRTOS heap implementation")

# Now add FreeRTOS as subdirectory
add_subdirectory(${freertos_SOURCE_DIR} ${freertos_BINARY_DIR})

# ------------------------------------------------------------------
# Paths derived from FetchContent
# ------------------------------------------------------------------
set(CUBE_DIR  ${stm32cubeh7_SOURCE_DIR})
set(HAL_DIR   ${CUBE_DIR}/Drivers/STM32H7xx_HAL_Driver)
set(CMSIS_DIR ${CUBE_DIR}/Drivers/CMSIS)
set(LWIP_DIR  ${CUBE_DIR}/Middlewares/Third_Party/LwIP)

# ------------------------------------------------------------------
# STM32 HAL sources (only the modules we need)
# ------------------------------------------------------------------
set(HAL_SOURCES
    ${HAL_DIR}/Src/stm32h7xx_hal.c
    ${HAL_DIR}/Src/stm32h7xx_hal_cortex.c
    ${HAL_DIR}/Src/stm32h7xx_hal_rcc.c
    ${HAL_DIR}/Src/stm32h7xx_hal_rcc_ex.c
    ${HAL_DIR}/Src/stm32h7xx_hal_pwr.c
    ${HAL_DIR}/Src/stm32h7xx_hal_pwr_ex.c
    ${HAL_DIR}/Src/stm32h7xx_hal_gpio.c
    ${HAL_DIR}/Src/stm32h7xx_hal_spi.c
    ${HAL_DIR}/Src/stm32h7xx_hal_spi_ex.c
    ${HAL_DIR}/Src/stm32h7xx_hal_uart.c
    ${HAL_DIR}/Src/stm32h7xx_hal_uart_ex.c
    ${HAL_DIR}/Src/stm32h7xx_hal_dma.c
    ${HAL_DIR}/Src/stm32h7xx_hal_dma_ex.c
    ${HAL_DIR}/Src/stm32h7xx_hal_tim.c
    ${HAL_DIR}/Src/stm32h7xx_hal_tim_ex.c
    ${HAL_DIR}/Src/stm32h7xx_hal_eth.c
    ${HAL_DIR}/Src/stm32h7xx_hal_eth_ex.c
    ${HAL_DIR}/Src/stm32h7xx_hal_exti.c
    ${HAL_DIR}/Src/stm32h7xx_hal_flash.c
    ${HAL_DIR}/Src/stm32h7xx_hal_flash_ex.c
    ${HAL_DIR}/Src/stm32h7xx_hal_iwdg.c
)

# ------------------------------------------------------------------
# CMSIS startup (assembly)
# ------------------------------------------------------------------
set(STARTUP_ASM ${CMSIS_DIR}/Device/ST/STM32H7xx/Source/Templates/gcc/startup_stm32h723xx.s)

# ------------------------------------------------------------------
# lwIP sources (core + IPv4 + netif + API)
# ------------------------------------------------------------------
file(GLOB LWIP_CORE_SOURCES    ${LWIP_DIR}/src/core/*.c)
file(GLOB LWIP_CORE4_SOURCES   ${LWIP_DIR}/src/core/ipv4/*.c)
file(GLOB LWIP_API_SOURCES     ${LWIP_DIR}/src/api/*.c)
file(GLOB LWIP_NETIF_SOURCES   ${LWIP_DIR}/src/netif/*.c)

set(LWIP_SOURCES
    ${LWIP_CORE_SOURCES}
    ${LWIP_CORE4_SOURCES}
    ${LWIP_API_SOURCES}
    ${LWIP_NETIF_SOURCES}
    # Our own FreeRTOS sys_arch (replaces CubeH7's CMSIS-OS version)
    src/net/lwip_arch/sys_arch.c
)

# ------------------------------------------------------------------
# Application sources
# ------------------------------------------------------------------
set(APP_SOURCES
    src/main.cpp
    src/syscalls.c
    src/stm32h7xx_it.c
    src/system_stm32h7xx.c
    src/bsp/clock.c
    src/bsp/gpio.c
    src/bsp/spi.c
    src/bsp/uart.c
    src/bsp/watchdog.c
    src/net/eth.c
    src/net/stream.cpp
    src/cca/cc1101.c
    src/cca/cca_timer.c
    src/cca/cca_task.cpp
    src/cca/cca_tdma.cpp
    src/cca/cca_commands.cpp
    src/cca/cca_pairing.cpp
    src/cca/cca_auto_pair.cpp
    src/ccx/ccx_task.cpp
    src/ccx/ccx_cbor.c
    src/ccx/ccx_msg.c
    src/ccx/coap.c
    src/ccx/hdlc.c
    src/ccx/smp_serial.c
    src/ccx/spinel_frame.c
    src/ccx/ipv6_udp.c
    src/shell/shell.cpp
    src/storage/flash_store.cpp
)

# ------------------------------------------------------------------
# Include paths
# ------------------------------------------------------------------
set(INCLUDE_DIRS
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/src/bsp
    ${CMAKE_CURRENT_SOURCE_DIR}/src/cca
    ${CMAKE_CURRENT_SOURCE_DIR}/src/ccx
    ${CMAKE_CURRENT_SOURCE_DIR}/src/net
    ${CMAKE_CURRENT_SOURCE_DIR}/src/shell
    ${CMAKE_CURRENT_SOURCE_DIR}/src/storage
    ${HAL_DIR}/Inc
    ${CMSIS_DIR}/Include
    ${CMSIS_DIR}/Device/ST/STM32H7xx/Include
    ${freertos_SOURCE_DIR}/include
    ${freertos_SOURCE_DIR}/portable/GCC/ARM_CM7/r0p1
    ${LWIP_DIR}/src/include
    # Our own arch/ directory (overrides CubeH7's CMSIS-OS sys_arch)
    ${CMAKE_CURRENT_SOURCE_DIR}/src/net/lwip_arch
)

# ------------------------------------------------------------------
# Build target
# ------------------------------------------------------------------
add_executable(${PROJECT_NAME}.elf
    ${STARTUP_ASM}
    ${HAL_SOURCES}
    ${LWIP_SOURCES}
    ${APP_SOURCES}
)

target_include_directories(${PROJECT_NAME}.elf PRIVATE ${INCLUDE_DIRS})

target_compile_definitions(${PROJECT_NAME}.elf PRIVATE
    STM32H723xx
    USE_HAL_DRIVER
)

# Link against FreeRTOS-Kernel library (built by add_subdirectory)
target_link_libraries(${PROJECT_NAME}.elf PRIVATE freertos_kernel)

# ------------------------------------------------------------------
# Linker
# ------------------------------------------------------------------
set(LINKER_SCRIPT ${CMAKE_CURRENT_SOURCE_DIR}/linker/STM32H723ZGTx_FLASH.ld)

target_link_options(${PROJECT_NAME}.elf PRIVATE
    -T${LINKER_SCRIPT}
    -mcpu=cortex-m7 -mthumb -mfpu=fpv5-d16 -mfloat-abi=hard
    -Wl,--gc-sections
    -Wl,--print-memory-usage
    -Wl,--no-warn-rwx-segments
    --specs=nano.specs
    --specs=nosys.specs
    -lc -lm -lnosys
)

set_target_properties(${PROJECT_NAME}.elf PROPERTIES
    LINK_DEPENDS ${LINKER_SCRIPT}
)

# ------------------------------------------------------------------
# Post-build: generate .bin and .hex
# ------------------------------------------------------------------
add_custom_command(TARGET ${PROJECT_NAME}.elf POST_BUILD
    COMMAND ${CMAKE_OBJCOPY} -O binary $<TARGET_FILE:${PROJECT_NAME}.elf> ${PROJECT_NAME}.bin
    COMMAND ${CMAKE_OBJCOPY} -O ihex   $<TARGET_FILE:${PROJECT_NAME}.elf> ${PROJECT_NAME}.hex
    COMMAND ${CMAKE_SIZE} $<TARGET_FILE:${PROJECT_NAME}.elf>
    COMMENT "Generating .bin and .hex, printing size"
)
