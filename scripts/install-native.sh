#!/usr/bin/env bash

set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
for program in ags sass install sed realpath mktemp grep cmp; do
  if ! command -v "$program" >/dev/null 2>&1; then
    printf 'Missing required build command: %s\n' "$program" >&2
    exit 1
  fi
done

prefix=$(realpath -m -- "${PREFIX:-$HOME/.local}")
bindir=$(realpath -m -- "${BINDIR:-$prefix/bin}")
libexecdir=$(realpath -m -- "${LIBEXECDIR:-$prefix/libexec}")
datadir=$(realpath -m -- "${DATADIR:-$prefix/share}")
appdatadir="$datadir/ags2-shell"
main_bin="$bindir/ags2-shell"
wallpaper_bin="$libexecdir/ags2-shell-wallpaper"

if [[ "$prefix$bindir$libexecdir$datadir" =~ [[:cntrl:]] ]]; then
  printf 'Install paths containing control characters are not supported.\n' >&2
  exit 1
fi

cd "$root"
./style/compile/build.sh

install -Dm644 style/compile/main.css "$appdatadir/style/compile/main.css"
install -d "$bindir" "$libexecdir"

stage=$(mktemp -d "${TMPDIR:-/tmp}/ags2-shell-bundle.XXXXXXXX")
trap 'rm -f -- "$stage/main" "$stage/wallpaper"; rmdir -- "$stage"' EXIT
ags bundle shell/wallpaper.tsx "$stage/wallpaper" -g 4
js_string() {
  local escaped
  escaped=$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  printf '"%s"' "$escaped"
}
ags bundle shell/main.tsx "$stage/main" -g 4 \
  -d "WALLPAPER_BIN=$(js_string "$wallpaper_bin")" \
  -d "STYLE_DIR=$(js_string "$appdatadir")"

for launcher in "$stage/main" "$stage/wallpaper"; do
  grep -q '^file=' "$launcher"
  grep -q '> \$file$' "$launcher"
  grep -q -- '-m \$file \$@$' "$launcher"
  sed -i \
    -e 's|^file=.*$|set -eo pipefail; umask 077; file=$(mktemp "${XDG_RUNTIME_DIR:-/tmp}/ags2-shell.XXXXXXXX"); trap '\''rm -f -- "$file"'\'' EXIT|' \
    -e 's|> \$file$|> "$file"|' \
    -e 's|-m \$file \$@$|-m "$file" "$@"|' "$launcher"
done

install -Dm755 "$stage/wallpaper" "$wallpaper_bin"
install -Dm755 "$stage/main" "$main_bin"

printf 'Installed ags2-shell to %s\n' "$main_bin"
