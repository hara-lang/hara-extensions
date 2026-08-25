# Hara Extensions

Editor and browser integrations for the [Hara](https://github.com/hara-lang/hara)
language and runtime.

## Components

- [`hara-emacs/`](hara-emacs/) — Emacs editing, REPL, RESP, Xref, completion,
  and `code.manage` integration.
- [`hara-chrome/`](hara-chrome/) — browser integration for Hara workflows.
- [`hara-lsp/`](hara-lsp/) — language-server support.
- [`hara-runtime/`](hara-runtime/) — runtime-facing extension packages.
- [`hara-vscode/`](hara-vscode/) — Visual Studio Code integration.

## Hara for Emacs

`hara-mode` requires Emacs 29.1 or newer. It connects to a Hara runtime through
the native `hara` launcher, which can be configured explicitly when needed:

```elisp
(setq hara-command "/path/to/hara-emacs/bin/hara")
```

After the MELPA recipe is available, install it with `package.el`:

```elisp
(require 'package)
(add-to-list 'package-archives '("melpa" . "https://melpa.org/packages/") t)
(package-initialize)
(package-refresh-contents)
(package-install 'hara-mode)
```

The package provides `hara-mode` and `hara-manage`. See the
[`hara-emacs` guide](hara-emacs/README.md) for checkout installation,
configuration, keybindings, and development workflows.

## Development

Run the Emacs package tests from its directory:

```sh
cd hara-emacs
make test
```

`make test` compiles bytecode for the active Emacs, runs the install smoke test,
and executes the ERT suite. Generated `.elc` files are intentionally not
tracked because they are tied to the Emacs version that created them.

## License

Hara Extensions is licensed under the [Apache License 2.0](LICENSE).
