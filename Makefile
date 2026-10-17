# ModelHitch Swift SDK — developer targets
# boring, reproducible steps only
TARGET_DIR := swift-sdk

.PHONY: build test lint format all clean

all: lint build test

build:
	cd $(TARGET_DIR) && swift build

test:
	cd $(TARGET_DIR) && swift test

lint:
	cd $(TARGET_DIR) && swift-format lint --recursive --strict Sources Tests

format:
	cd $(TARGET_DIR) && swift-format format --recursive --in-place Sources Tests

clean:
	cd $(TARGET_DIR) && swift package clean
