PREFIX ?= $(HOME)/.local
DESTDIR ?=
DATADIR ?= $(PREFIX)/share
LISPDIR ?= $(DATADIR)/emacs/site-lisp/hara-mode
INSTALL ?= install
EMACS ?= emacs

ELISP_SOURCES := hara-mode.el hara-manage.el
ELISP_COMPILED := $(ELISP_SOURCES:.el=.elc)

.PHONY: all test test-install compile clean install install-files uninstall upgrade \
  bin-build bin-build-truffle bin-build-native bin-build-rust bin-build-rust-lite \
  bin-install bin-install-truffle bin-install-native bin-install-rust bin-install-rust-lite \
  bin-clean project-native-status project-native-check _project-native-state

all: compile test

test: compile test-install
	$(EMACS) --batch -L . -L test \
	  -l test/hara-mode-test.el \
	  -l test/hara-manage-test.el \
	  -f ert-run-tests-batch-and-exit

test-install:
	sh test/install-test.sh

compile:
	$(EMACS) --batch -L . -f batch-byte-compile \
	  $(ELISP_SOURCES)

clean:
	rm -f $(ELISP_COMPILED)

install: compile
	@$(MAKE) --no-print-directory install-files

install-files:
	@for file in $(ELISP_SOURCES) $(ELISP_COMPILED); do \
	  test -f "$$file" || { printf 'Missing install input: %s\n' "$$file" >&2; exit 1; }; \
	done
	$(INSTALL) -d "$(DESTDIR)$(LISPDIR)"
	$(INSTALL) -m 644 $(ELISP_SOURCES) $(ELISP_COMPILED) "$(DESTDIR)$(LISPDIR)/"
	@printf 'Installed hara-emacs: %s\n' "$(LISPDIR)"
	@printf 'Ensure this directory is present in Emacs load-path.\n'

uninstall:
	rm -f $(addprefix $(DESTDIR)$(LISPDIR)/,$(ELISP_SOURCES) $(ELISP_COMPILED))
	@rmdir "$(DESTDIR)$(LISPDIR)" 2>/dev/null || true

upgrade:
	$(EMACS) --batch \
	  --eval '(require (quote package))' \
	  --eval '(load-library "package-vc")' \
	  --eval '(package-initialize)' \
	  --eval '(when-let ((desc (cadr (assq (quote hara-mode) package-alist)))) (package-vc-upgrade desc))'

# ---------------------------------------------------------------------------
# Runtime binary build/install targets
# ---------------------------------------------------------------------------

HARA_ROOT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../technology/hara
HARA_PROJECT ?= .
LOCAL_BIN ?= $(PREFIX)/bin
LOCAL_SHARE ?= $(PREFIX)/share/hara-mode

TRUFFLE_JAR_SRC := $(HARA_ROOT)/core/java/target/hara-truffle.jar
TRUFFLE_JAR_DST := $(LOCAL_SHARE)/hara-truffle.jar
NATIVE_SRC := $(HARA_ROOT)/core/target/hara-truffle
RUST_SRC := $(HARA_ROOT)/core/rust/target/release/hara
RUST_LITE_SRC := $(HARA_ROOT)/core/rust/target/release/hara-lite

bin-build: bin-build-truffle
bin-install: bin-install-truffle

bin-build-truffle:
	mvn -f "$(HARA_ROOT)/core/java/pom.xml" -Ptruffle -DskipTests package

bin-install-truffle: bin-build-truffle
	mkdir -p "$(LOCAL_BIN)" "$(LOCAL_SHARE)"
	install -m 644 "$(TRUFFLE_JAR_SRC)" "$(TRUFFLE_JAR_DST)"
	printf '%s\n' '#!/bin/sh' \
	  'exec java -jar "$${HARA_RUNTIME_JAR:-$${HOME}/.local/share/hara-mode/hara-truffle.jar}" "$$@"' \
	  > "$(LOCAL_BIN)/hara-truffle"
	chmod 755 "$(LOCAL_BIN)/hara-truffle"

bin-build-native:
	bash "$(HARA_ROOT)/scripts/runtime/build-truffle-native"

bin-install-native: bin-build-native
	mkdir -p "$(LOCAL_BIN)"
	install -m 755 "$(NATIVE_SRC)" "$(LOCAL_BIN)/hara-native"

bin-build-rust:
	cargo build --release --manifest-path "$(HARA_ROOT)/core/rust/Cargo.toml"

bin-install-rust: bin-build-rust
	mkdir -p "$(LOCAL_BIN)"
	install -m 755 "$(RUST_SRC)" "$(LOCAL_BIN)/hara-rust"

bin-build-rust-lite:
	cargo build --release --manifest-path "$(HARA_ROOT)/core/rust/Cargo.toml" --bin hara-lite

bin-install-rust-lite: bin-build-rust-lite
	mkdir -p "$(LOCAL_BIN)" "$(PREFIX)/share/hara-lite"
	install -m 755 "$(RUST_LITE_SRC)" "$(LOCAL_BIN)/hara-rust-lite"
	install -m 644 "$(HARA_ROOT)/core/project.edn" "$(PREFIX)/share/hara-lite/project.edn"
	cp -R "$(HARA_ROOT)/core/lib" "$(PREFIX)/share/hara-lite/"

bin-clean:
	rm -f "$(TRUFFLE_JAR_DST)" "$(LOCAL_BIN)/hara-truffle" \
	      "$(LOCAL_BIN)/hara-native" "$(LOCAL_BIN)/hara-rust" \
	      "$(LOCAL_BIN)/hara-rust-lite"

# ---------------------------------------------------------------------------
# Project-configured Rust Native freshness checks
# ---------------------------------------------------------------------------

# `:project/distribution :host` is the executable used by C-c C-t. Resolve it
# through hara-mode's deliberately small EDN reader so this check agrees with
# Emacs instead of guessing from an arbitrary project.edn parser.
project-native-status: NATIVE_CHECK_MODE = status
project-native-status: _project-native-state

project-native-check: NATIVE_CHECK_MODE = check
project-native-check: _project-native-state

_project-native-state:
	@set -eu; \
	project="$$(cd "$(HARA_PROJECT)" && pwd -P)"; \
	configured="$$(HARA_PROJECT_ROOT="$$project" $(EMACS) --batch -Q -L . \
	  --eval '(progn (load "hara-mode") (princ (or (hara--project-edn-map-string (getenv "HARA_PROJECT_ROOT") ":project/distribution" ":host") "")))')"; \
	if test -z "$$configured"; then \
	  printf 'NATIVE UNKNOWN project=%s reason=no :project/distribution :host\n' "$$project" >&2; \
	  test "$(NATIVE_CHECK_MODE)" != check; \
	  exit 0; \
	fi; \
	case "$$configured" in \
	  /*) host="$$configured" ;; \
	  *) host="$$project/$$configured" ;; \
	esac; \
	host="$$(cd "$$(dirname "$$host")" && pwd -P)/$$(basename "$$host")"; \
	if test ! -x "$$host"; then \
	  printf 'NATIVE STALE project=%s host=%s reason=missing-or-not-executable\n' "$$project" "$$host" >&2; \
	  test "$(NATIVE_CHECK_MODE)" != check; \
	  exit 0; \
	fi; \
	native_root="$$(cd "$$(dirname "$$host")/../../../.." && pwd -P)"; \
	manifest="$$native_root/core/rust/Cargo.toml"; \
	if test ! -f "$$manifest"; then \
	  printf 'NATIVE UNKNOWN project=%s host=%s reason=not-a-hara-native-release-layout\n' "$$project" "$$host" >&2; \
	  test "$(NATIVE_CHECK_MODE)" != check; \
	  exit 0; \
	fi; \
	newer="$$(find "$$native_root/core/rust" -type f \
	  \( -name '*.rs' -o -name Cargo.toml -o -name Cargo.lock \) \
	  -newer "$$host" -print -quit)"; \
	dirty="$$(git -C "$$native_root" status --porcelain -- core/rust 2>/dev/null || true)"; \
	if test -n "$$newer"; then \
	  printf 'NATIVE STALE project=%s host=%s newer-source=%s\n' "$$project" "$$host" "$$newer" >&2; \
	  test "$(NATIVE_CHECK_MODE)" != check; \
	  exit 0; \
	fi; \
	if test -n "$$dirty"; then \
	  printf 'NATIVE CURRENT project=%s host=%s note=source-worktree-dirty-but-host-is-newer\n' "$$project" "$$host"; \
	else \
	  printf 'NATIVE CURRENT project=%s host=%s\n' "$$project" "$$host"; \
	fi
