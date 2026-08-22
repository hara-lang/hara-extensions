SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

RESP_PORT ?= 7355
WS_PORT ?= 7356
PROFILE_DIR ?=
URL ?= about:blank
HEADLESS ?= true
CHATGPT_PROFILE_DIR ?= $(HOME)/.greenways/hara-chrome/chatgpt-profile
TRIPO_PROFILE_DIR ?= $(HOME)/.greenways/hara-chrome/tripo-profile
PLAYWRIGHT_INSTALL_FLAGS ?= --with-deps --no-shell

EXTENSION_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
DETECTED_WORKSPACE_ROOT := $(shell \
  directory="$(EXTENSION_DIR)"; \
  while [ "$$directory" != "/" ]; do \
    if [ -x "$$directory/technology/hara/scripts/runtime/build-hara-wasm-raw" ] \
       && [ -d "$$directory/extensions/hara-chrome" ]; then \
      printf '%s' "$$directory"; \
      break; \
    fi; \
    directory="$$(dirname "$$directory")"; \
  done)
HARA_WORKSPACE_ROOT ?= $(DETECTED_WORKSPACE_ROOT)
HARA_DIR = $(HARA_WORKSPACE_ROOT)/technology/hara
HARA_BIN = $(HARA_DIR)/core/hara
HARA_BUILD = $(HARA_DIR)/scripts/runtime/build-hara-wasm-raw
HARA_RUN = "$(HARA_BIN)" --root "$(HARA_WORKSPACE_ROOT)" --allow-file --offline --no-color
SYNC_FILE = $(EXTENSION_DIR)/scripts/sync-runtime.hal
SYNC_TEST = $(EXTENSION_DIR)/test/sync-runtime-test.hal

.NOTPARALLEL:
.PHONY: help check-workspace dependencies browser build sync dev chatgpt-login tripo-login test test-fast test-sync test-browser

help:
	@printf '%s\n' \
	  'make build          build Hara WASM and stage extension assets' \
	  'make dev            install dependencies, build, and run Chromium' \
	  'make chatgpt-login  run headed Chromium with a persistent ChatGPT profile' \
	  'make tripo-login    run headed Chromium with a persistent Tripo Studio profile' \
	  'make test           clean-capable Node suite; builds and stages vendor assets first' \
	  'make test-fast      focused Node tests that do not import staged runtime assets' \
	  'make test-sync      validate native asset sync in fresh Hara processes' \
	  'make test-browser   build and run the full Playwright extension suite' \
	  '' \
	  'Variables: RESP_PORT=7355 WS_PORT=7356 PROFILE_DIR= URL=about:blank HEADLESS=true' \
	  '           CHATGPT_PROFILE_DIR=$$HOME/.greenways/hara-chrome/chatgpt-profile' \
	  '           TRIPO_PROFILE_DIR=$$HOME/.greenways/hara-chrome/tripo-profile HARA_WORKSPACE_ROOT='

check-workspace:
	@if [ -z "$(HARA_WORKSPACE_ROOT)" ]; then \
	  echo 'Unable to detect the Greenways meta-workspace root.' >&2; \
	  echo 'Set HARA_WORKSPACE_ROOT to the directory containing application/ and technology/.' >&2; \
	  exit 2; \
	fi
	@test -x "$(HARA_BUILD)" || { echo "Missing canonical Hara WASM builder: $(HARA_BUILD)" >&2; exit 2; }
	@test -x "$(HARA_BIN)" || { echo "Missing Hara launcher: $(HARA_BIN)" >&2; exit 2; }
	@test -d "$(HARA_WORKSPACE_ROOT)/extensions/hara-chrome" || { \
	  echo "HARA_WORKSPACE_ROOT does not contain extensions/hara-chrome" >&2; \
	  exit 2; \
	}
	@test -f "$(EXTENSION_DIR)/ui/hara-ui/tokens.css" || { \
	  echo 'Missing ui/hara-ui checkout; initialise the hara-ui submodule/workspace dependency.' >&2; \
	  exit 2; \
	}
	@test -f "$(EXTENSION_DIR)/ui/visual-language/src/v2-tool.css" || { \
	  echo 'Missing ui/visual-language checkout; initialise the pinned visual-language submodule.' >&2; \
	  exit 2; \
	}

dependencies:
	@if [ ! -d node_modules ] || ! npm ls --silent >/dev/null 2>&1; then npm ci; fi

browser: dependencies
	npx playwright install $(PLAYWRIGHT_INSTALL_FLAGS) chromium

build: check-workspace
	"$(HARA_BUILD)" vm
	cd "$(HARA_WORKSPACE_ROOT)" && $(HARA_RUN) run "$(SYNC_FILE)"

sync: check-workspace
	cd "$(HARA_WORKSPACE_ROOT)" && $(HARA_RUN) run "$(SYNC_FILE)"

dev:
	$(MAKE) dependencies
	$(MAKE) browser
	$(MAKE) build
	RESP_PORT="$(RESP_PORT)" WS_PORT="$(WS_PORT)" PROFILE_DIR="$(PROFILE_DIR)" URL="$(URL)" HEADLESS="$(HEADLESS)" node scripts/dev-runtime.mjs

chatgpt-login:
	@test -n "$(CHATGPT_PROFILE_DIR)" || { echo 'CHATGPT_PROFILE_DIR must not be empty' >&2; exit 2; }
	@mkdir -p "$(CHATGPT_PROFILE_DIR)"
	@chmod 700 "$(CHATGPT_PROFILE_DIR)"
	$(MAKE) dev HEADLESS=false PROFILE_DIR="$(CHATGPT_PROFILE_DIR)" URL=https://chatgpt.com

tripo-login:
	@test -n "$(TRIPO_PROFILE_DIR)" || { echo 'TRIPO_PROFILE_DIR must not be empty' >&2; exit 2; }
	@mkdir -p "$(TRIPO_PROFILE_DIR)"
	@chmod 700 "$(TRIPO_PROFILE_DIR)"
	$(MAKE) dev HEADLESS=false PROFILE_DIR="$(TRIPO_PROFILE_DIR)" URL=https://studio.tripo3d.ai

test:
	$(MAKE) dependencies
	$(MAKE) build
	node --test test/*.test.js

test-fast: dependencies
	node --test \
	  test/browser-target.test.js \
	  test/chatgpt-configuration.test.js \
	  test/chatgpt-login-configuration.test.js \
	  test/chatgpt-login.test.js \
	  test/chatgpt-phase1-configuration.test.js \
	  test/chatgpt-search-project.test.js \
	  test/chatgpt-service.test.js \
	  test/configuration.test.js \
	  test/control-model.test.js \
	  test/control-supervisor.test.js \
	  test/dev-runtime.test.js \
	  test/dom-existence-probe.test.js \
	  test/dom-service.test.js \
	  test/host-bridge-codec.test.js \
	  test/offscreen-configuration.test.js \
	  test/popup-v2.test.js \
	  test/profile-cleanup.test.js \
	  test/resp-bridge.test.js \
	  test/resp-client.test.js \
	  test/resp-protocol.test.js \
	  test/runtime-client.test.js \
	  test/runtime-host-core.test.js \
	  test/runtime-login.test.js \
	  test/runtime-supervisor.test.js \
	  test/tripo-configuration.test.js \
	  test/tripo-login.test.js \
	  test/tripo-service.test.js

test-sync: check-workspace
	"$(HARA_BUILD)" vm
	cd "$(HARA_WORKSPACE_ROOT)" && cat "$(SYNC_FILE)" | $(HARA_RUN) stdin
	cd "$(HARA_WORKSPACE_ROOT)" && $(HARA_RUN) run "$(SYNC_FILE)"
	cd "$(HARA_WORKSPACE_ROOT)" && $(HARA_RUN) run "$(SYNC_TEST)"

test-browser:
	$(MAKE) dependencies
	$(MAKE) browser
	$(MAKE) build
	npx playwright test
