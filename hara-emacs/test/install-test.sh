#!/bin/sh
# Exercise staged hara-emacs installation without requiring Emacs.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PACKAGE_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/hara-emacs-install.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM

SOURCE="$WORK/source"
STAGE="$WORK/stage"
PREFIX=/usr/local
LISPDIR="$PREFIX/share/emacs/site-lisp/hara-mode"

mkdir -p "$SOURCE/test"
cp "$PACKAGE_ROOT/Makefile" "$SOURCE/Makefile"
cp "$PACKAGE_ROOT/hara-mode.el" "$SOURCE/hara-mode.el"
cp "$PACKAGE_ROOT/hara-manage.el" "$SOURCE/hara-manage.el"
printf 'compiled hara-mode fixture\n' > "$SOURCE/hara-mode.elc"
printf 'compiled hara-manage fixture\n' > "$SOURCE/hara-manage.elc"

make -C "$SOURCE" --no-print-directory install-files \
  DESTDIR="$STAGE" PREFIX="$PREFIX"

for file in hara-mode.el hara-manage.el hara-mode.elc hara-manage.elc; do
  test -r "$STAGE$LISPDIR/$file"
done

make -C "$SOURCE" --no-print-directory uninstall \
  DESTDIR="$STAGE" PREFIX="$PREFIX"

for file in hara-mode.el hara-manage.el hara-mode.elc hara-manage.elc; do
  test ! -e "$STAGE$LISPDIR/$file"
done

printf 'hara-emacs make install checks passed\n'
