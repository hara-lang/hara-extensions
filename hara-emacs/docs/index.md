# Hara for Emacs

`hara-mode.el` provides Hara editing with Paredit, protocol-4 evaluation, inline results, ElDoc, asynchronous
Eglot completion, manual diagnostics, Xref navigation, Imenu, sessions, project-aware server
startup, and a REPL. Its core uses built-in Emacs APIs; the optional documentation popup uses
`eldoc-box`.

`hara-manage.el` adds native Foundation-compatible `code.manage` previews, writes, and navigable findings.

Install from GitHub with `package-vc` (Emacs 29.1+):

```elisp
(package-vc-install
 '(hara-mode :url "https://github.com/hara-lang/hara-extensions"
             :lisp-dir "hara-emacs"))
(require 'hara-mode)
```

Or use a plain checkout:

```elisp
(add-to-list 'load-path "/path/to/hara-extensions/hara-emacs")
(require 'hara-mode)
```

### Install from a checkout with Make

`make install` byte-compiles and installs both modules. The default destination
is `~/.local/share/emacs/site-lisp/hara-mode`:

```sh
make install
make uninstall
```

For a system prefix or packaging root:

```sh
make install PREFIX=/usr/local
make install DESTDIR="$PWD/pkgroot" PREFIX=/usr
```

Override `LISPDIR` to choose an exact Emacs Lisp directory. When the selected
location is not already in `load-path`, add it in your Emacs configuration:

```elisp
(add-to-list 'load-path "~/.local/share/emacs/site-lisp/hara-mode")
(require 'hara-mode)
```

The package install does not install a Hara runtime. Install Hara separately
from its source checkout with `make install`, or otherwise ensure `hara` is on
`PATH`.

The shared language service is in `../hara-lsp`. Build and install it with:

```sh
cd /path/to/hara-extensions/hara-lsp
make install
```

When `hara-lsp` is available, the first `.hal` buffer beneath a `project.edn`
schedules one Eglot language service for that project; later Hara buffers attach
to the same service. Eglot synchronizes text and versions on open/edit, but the
service does not analyze on every change. Completion is deliberately
cache-only while typing: it returns static forms and definitions from an
analysis already available for the current version, so Company cannot start a
whole-file analysis on every keystroke. Definitions, hover, references,
rename, and formatting remain available through Eglot. Run
`M-x hara-lsp-diagnose-buffer` (or `C-c C-l D`) when you want diagnostics;
results are published through Flymake. The RESP connection is also discovered
or started once per project, asynchronously, so visiting a file does not wait
for endpoint discovery or runtime startup.
Hara keeps Imenu local so Treemacs file navigation does not make a synchronous
semantic request; use Eglot commands when semantic results are needed.
Set `hara-lsp-command` or `hara-lsp-service-project` to override discovery.

Open a `.hal` file and run `M-x hara-jack-in` or press `C-c C-j`. The client first reuses a
validated project endpoint, then checks `hara-host`/`hara-port`, and finally starts
`hara --port 0 headless`. Emacs-owned servers stop on `M-x hara-disconnect`.

The project server remains alive when source buffers are closed, so definitions
and exploratory state survive ordinary navigation. Evaluation automatically
synchronises the complete `ns`/`ns+` form when moving between namespaces.
Every project has its own REPL buffer, preventing a multi-project workspace from
sending input to the wrong runtime.

By default, opening the first local `.hal` file beneath a directory containing
`project.edn` schedules automatic RESP jack-in for that project. Additional
buffers reuse the project connection; standalone and remote files remain
disconnected. Customize `hara-auto-jack-in-projects` to disable this behavior.

The `hara` launcher executes the prebuilt `core/java/target/hara-truffle.jar`; it never invokes Maven during
jack-in. Build or refresh that executable fat JAR explicitly with
`mvn -f core/java/pom.xml -Ptruffle -DskipTests package`. Override its location with `HARA_RUNTIME_JAR` when using an
installed artifact. Explicit jack-in endpoint publication may wait up to
`hara-server-start-timeout` (15 seconds by default), while automatic discovery
uses nonblocking endpoint negotiation bounded by `hara-connect-timeout`.

### Per-project Hara executable

Set a top-level `:project/hara-bin` string in `project.edn` to select the
runtime used by Hara Emacs for that project. A relative path is resolved from
the project root; the target must be an executable file. This takes precedence
over the global `hara-command` fallback, so a checkout can pin Emacs to the Hara
distribution it was developed and tested with:

```clojure
{:hara/type :project
 :project/id acme/widgets
 :project/hara-bin "target/hara/bin/hara"}
```

An absolute path is also supported. For a bare command name, Hara Emacs uses
the executable found on `exec-path`. If the configured binary is missing or
not executable, jack-in stops with an error naming that path instead of
silently starting a different runtime.

Common commands:

- `C-e`: Etude's evaluate-at-point command (`C-u C-e` evaluates and inserts the result at point)
- `C-c C-e`: evaluate the preceding form (`C-u C-c C-e` also inserts the result at point)
- `C-c C-i`: evaluate the preceding form and insert the result at point
- `C-c C-c`: evaluate the top-level form
- `C-c C-r`: evaluate the region
- `C-c C-k`: evaluate the buffer
- `C-c C-z`: open the Hara REPL
- `C-c C-d`: show documentation
- `C-c C-p`: show documentation near point with `eldoc-box`
- `C-c C-t`: test the current file with the native Hara project runner
- `C-c C-a`: test the whole Hara project
- `C-c C-o`: toggle between conventional source and test files
- `C-c C-m`: open the `code.manage` prefix (`s`/`i`/`p`/`n`/`d`/`m`)
- `C-c C-l D`: request diagnostics for the buffer
- `M-.`: jump to a source-backed definition with Xref
- `M-,`: return through Xref history

## Daily REPL-driven loop

The intended inner loop is deliberately close to Foundation Base and CIDER:

1. Open a `.hal` file. Project services start in the background; `C-c C-j`
   performs an explicit synchronous jack-in when needed.
2. Run `C-c C-k` once to load the buffer and its namespace.
3. Edit a definition and use `C-c C-c`, or evaluate a smaller expression with
   `C-c C-e`.
4. Use `C-c C-o` to move between source and its `_test.hal` counterpart.
5. Run `C-c C-t` for the focused test in a fresh native process. From a source
   buffer this automatically targets the existing conventional test file.
6. Keep exploratory expressions in the project REPL with `C-c C-z`. The live
   REPL is feedback; the fresh focused test remains the saved-code authority.

Use `C-c C-m s` to scaffold a missing test before toggling to it. Run
`M-x hara-disconnect` only when you intentionally want to stop the project
server and discard its live state.

Evaluation results use Hara-owned boxed, syntax-highlighted overlays at the end of the line, with
fringe feedback and adaptive wrapping for long values. They clear after the next command. The
timeout configured by `hara-inline-result-duration` remains a fallback; customize
`hara-inline-result-max-length` to control truncation.
ElDoc stays silent until the current buffer has explicitly connected to Hara.
Evaluation failures open a structured `*Hara Error*` backtrace buffer. When a
protocol-4 runtime provides diagnostics it shows the exception code, bounded
data, cause chain, primary source excerpt, and clickable coroutine/fiber
frames; older runtimes retain the compatible textual stack fallback.

## `code.manage` workflows

Hara buffers expose project workflows beneath `C-c C-m`:

- `C-c C-m s` previews `scaffold`; with a prefix argument it prompts for `--added VERSION`.
- `C-c C-m i` previews `import`.
- `C-c C-m p` previews `purge`.
- `C-c C-m n` reports incomplete definitions and `TODO` facts.
- `C-c C-m d` reports historical M/T/N/C pedantic findings.
- `C-c C-m m` selects any workflow with completion.

The integration resolves the current `ns` or `ns+` declaration, normalizes a
`foo-test` buffer back to `foo`, saves affected Hara buffers, and invokes:

```text
hara --project ROOT --offline manage OP NAMESPACE --format editor-json
```

Editing operations render a unified diff and require confirmation before a
fresh `--write` invocation. Immediately before writing, every preview `before`
value is checked against disk; stale previews and paths escaping the project
root—including symlink-mediated escapes—are rejected. Reporting operations use
compilation-style `path:line:column` locations. Successful writes refresh
unmodified visiting buffers and open a newly created scaffold test.

Run tests with:

```sh
cd /path/to/hara-extensions/hara-emacs
make test        # run install checks plus the hara-mode and hara-manage ERT suites
make compile     # byte-compile hara-mode.el and hara-manage.el
make upgrade     # update the package-vc checkout in ~/.emacs.d/elpa
```

Build and install a Hara runtime (defaults to the Truffle jar):

```sh
cd /path/to/hara-extensions/hara-emacs
make bin-build            # compile the Truffle runtime jar
make bin-install          # install Truffle launcher + jar to ~/.local
make bin-build-native     # build GraalVM native image
make bin-install-native   # install native binary as ~/.local/bin/hara-native
make bin-build-rust       # build Rust release binary
make bin-install-rust     # install Rust binary as ~/.local/bin/hara-rust
make bin-build-rust-lite  # build the small Rust interpreter
make bin-install-rust-lite # install it as ~/.local/bin/hara-rust-lite
make bin-clean            # remove installed binaries and jar
```

The Emacs package ships with `hara-emacs/bin/hara`, which `hara-mode`
auto-detects and uses as `hara-command`. It runs the Truffle jar by default;
set `HARA_BACKEND=rust`, `rust-lite`, or `native` to switch backends, or
customize `hara-command` directly.

Or directly:

```sh
emacs -Q --batch -L . -L test \
  -l hara-mode-test.el \
  -l hara-manage-test.el -f ert-run-tests-batch-and-exit
```

## Troubleshooting

### `EVAL_ERROR: No host builtins are registered for namespace: std.foundation`

This almost always means hara-mode is using a stale runtime jar/binary. The
launcher prefers freshly-built artifacts in the repo root, then falls back to
`~/.local`. To fix:

```sh
cd /path/to/hara-extensions/hara-emacs
make bin-build-truffle   # or make bin-build for the default backend
make bin-install-truffle # update the fallback jar in ~/.local
make upgrade             # update the package-vc checkout in ~/.emacs.d/elpa
```

Then restart Emacs (or run `M-x package-vc-upgrade RET hara-mode RET`).

To see exactly which binary/jar the launcher picked, run it with diagnostics:

```sh
HARA_DIAGNOSTICS=1 ~/.emacs.d/elpa/hara-mode/hara-emacs/bin/hara eval '(+ 1 2)'
```

In Emacs, `M-x hara-jack-in` logs the resolved command to the message area.
Check `M-x describe-variable RET hara-command RET` to see what is configured.
