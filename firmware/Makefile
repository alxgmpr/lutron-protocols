# Convenience wrapper for CMake build
BUILD_DIR := build
PROJECT   := nucleo-firmware

.PHONY: build clean flash monitor reset test

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
	    -I src/cca -I src/ccx \
	    tests/test_main.cpp tests/test_crc.cpp tests/test_n81.cpp \
	    tests/test_decoder.cpp tests/test_cbor.cpp \
	    src/ccx/ccx_cbor.c src/ccx/ccx_msg.c \
	    -o $(BUILD_DIR)/test_runner && ./$(BUILD_DIR)/test_runner
