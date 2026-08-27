PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin
SHAREDIR ?= $(PREFIX)/share/hara-lsp

.PHONY: build check install uninstall clean

build:
	cargo build --release

check:
	cargo check

install: build
	install -d "$(BINDIR)" "$(SHAREDIR)/src/hara/lsp"
	install -m 755 target/release/hara-lsp "$(BINDIR)/hara-lsp"
	install -m 644 project.edn "$(SHAREDIR)/project.edn"
	install -m 644 src/hara/lsp/service.hal "$(SHAREDIR)/src/hara/lsp/service.hal"

uninstall:
	rm -f "$(BINDIR)/hara-lsp"
	rm -f "$(SHAREDIR)/project.edn" "$(SHAREDIR)/src/hara/lsp/service.hal"

clean:
	cargo clean
