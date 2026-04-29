# Convenience wrapper for CMake build
BUILD_DIR := build
PROJECT   := nucleo-firmware

# Source files for formatting/linting (excludes vendor code in build/_deps/)
APP_SOURCES := $(shell find src -name '*.c' -o -name '*.cpp' -o -name '*.h')
INCLUDE_DIRS := -I include -I src -I src/bsp -I src/cca -I src/ccx -I src/net -I src/shell -I src/storage

.PHONY: build clean flash monitor reset test format format-check lint build-check

build:
	@mkdir -p $(BUILD_DIR)
	@cd $(BUILD_DIR) && cmake -DCMAKE_BUILD_TYPE=Debug .. && cmake --build . -j$$(nproc 2>/dev/null || sysctl -n hw.ncpu)

release:
	@mkdir -p $(BUILD_DIR)
	@cd $(BUILD_DIR) && cmake -DCMAKE_BUILD_TYPE=Release .. && cmake --build . -j$$(nproc 2>/dev/null || sysctl -n hw.ncpu)

clean:
	rm -rf $(BUILD_DIR)

flash: build
	openocd -f openocd.cfg -c "program $(BUILD_DIR)/$(PROJECT).elf verify reset exit"

reset:
	openocd -f openocd.cfg -c "init; reset run; shutdown"

monitor:
	@# ST-LINK VCP serial console (USART3 on Nucleo, 115200 baud)
	@PORT=$$(ls /dev/cu.usbmodem* 2>/dev/null | head -1); \
	if [ -z "$$PORT" ]; then \
		echo "No ST-LINK VCP found. Check USB connection."; \
		exit 1; \
	fi; \
	echo "Connecting to $$PORT at 115200..."; \
	screen $$PORT 115200

test:
	@mkdir -p $(BUILD_DIR)
	clang++ -std=c++17 -Wall -Wextra -Wno-unused-parameter \
	    -I src/cca -I src/ccx -I tests/stubs \
	    tests/test_main.cpp tests/test_crc.cpp tests/test_n81.cpp \
	    tests/test_decoder.cpp tests/test_cbor.cpp \
	    tests/test_tdma.cpp tests/test_encoder.cpp \
	    tests/test_tdma_jobs.cpp tests/test_cmd_builders.cpp \
	    tests/test_cmd_stubs.cpp tests/test_hdlc.cpp \
	    tests/test_spinel.cpp tests/test_ccx_coap.cpp \
	    tests/test_smp_dfu.cpp tests/test_ota_tx.cpp \
	    src/cca/cca_commands.cpp \
	    src/ccx/ccx_cbor.c src/ccx/ccx_msg.c \
	    src/ccx/hdlc.c src/ccx/spinel_frame.c \
	    src/ccx/coap.c src/ccx/smp_serial.c \
	    -o $(BUILD_DIR)/test_runner && ./$(BUILD_DIR)/test_runner

build-check:
	@bash $(CURDIR)/check-build-warnings.sh

format:
	clang-format -i $(APP_SOURCES)

format-check:
	clang-format --dry-run --Werror $(APP_SOURCES)

lint:
	cppcheck --enable=warning,style,performance \
	    --error-exitcode=1 \
	    -j$$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4) \
	    --std=c11 --std=c++17 \
	    --suppressions-list=.cppcheck-suppress \
	    $(INCLUDE_DIRS) src/
