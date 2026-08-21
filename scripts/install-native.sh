#!/usr/bin/env bash
# Builds and installs native AGS launchers without requiring Nix.

set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
prefix=${PREFIX:-"$HOME/.local"}
bindir=${BINDIR:-"$prefix/bin"}
libexecdir=${LIBEXECDIR:-"$prefix/libexec"}
datadir=${DATADIR:-"$prefix/share"}
appdatadir="$datadir/ags2-shell"
main_bin="$bindir/ags2-shell"
wallpaper_bin="$libexecdir/ags2-shell-wallpaper"

case "$prefix$bindir$libexecdir$datadir" in
  *"'"*)
    printf 'Install paths containing single quotes are not supported.\n' >&2
    exit 1
    ;;
esac

for program in ags sass install sed; do
  if ! command -v "$program" >/dev/null 2>&1; then
    printf 'Missing required build command: %s\n' "$program" >&2
    exit 1
  fi
done

cd "$root"
./style/compile/build.sh

install -Dm644 style/compile/main.css "$appdatadir/style/compile/main.css"
install -d "$bindir" "$libexecdir"

ags bundle shell/wallpaper.tsx "$wallpaper_bin" -g 4
ags bundle shell/main.tsx "$main_bin" -g 4 \
  -d "WALLPAPER_BIN='$wallpaper_bin'" \
  -d "STYLE_DIR='$appdatadir'"

# AGS derives this temporary filename from the common bundle prefix. Give the
# main and wallpaper processes separate files so they cannot overwrite each other.
sed -i 's|^file=.*$|file="${XDG_RUNTIME_DIR:-/tmp}/ags2-shell-main-ags.js"|' "$main_bin"
sed -i 's|^file=.*$|file="${XDG_RUNTIME_DIR:-/tmp}/ags2-shell-wallpaper-ags.js"|' "$wallpaper_bin"

printf 'Installed ags2-shell to %s\n' "$main_bin"
