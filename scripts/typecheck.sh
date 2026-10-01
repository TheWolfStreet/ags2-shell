#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ ! -f $root/@girs/index.d.ts || ! -f $root/node_modules/ags/lib/index.ts || ! -f $root/node_modules/gnim/dist/index.ts ]]; then
  printf 'Missing AGS/GIR types; run npm run types in nix develop first.\n' >&2
  exit 1
fi
ags_root=$(realpath -- "$root/node_modules/ags")
gnim_root=$(realpath -- "$root/node_modules/gnim")
gir_types=()
for gir in "$root"/@girs/*.d.ts; do
  case $gir in
    */astal-3.0.d.ts|*/gdk-3.0.d.ts|*/gdkx11-3.0.d.ts|*/girepository-2.0.d.ts|*/gtk-3.0.d.ts) continue ;;
  esac
  gir_types+=("$gir")
done

for name in ags gnim; do
  output="$root/@girs/$name-types"
  if [[ -e $output ]]; then
    if [[ ! -d $output || -L $output ]]; then
      printf 'Not a generated type directory: %s\n' "$output" >&2
      exit 1
    fi
    rm -r -- "$output"
  fi
done

tsc --noCheck --declaration --emitDeclarationOnly --skipLibCheck --strictNullChecks \
  --target ES2020 --module ES2022 --moduleResolution Bundler \
  --rootDir "$gnim_root" --outDir "$root/@girs/gnim-types" \
  "$gnim_root"/dist/*.ts "$gnim_root"/dist/jsx/*.ts \
  "$gnim_root"/dist/gtk3/*.ts "$gnim_root"/dist/gtk4/*.ts \
  "$gnim_root"/dist/gnome/*.ts "${gir_types[@]}"

tsc --noCheck --declaration --emitDeclarationOnly --skipLibCheck --strictNullChecks \
  --target ES2020 --module ES2022 --moduleResolution Bundler \
  --rootDir "$ags_root" --outDir "$root/@girs/ags-types" \
  "$ags_root"/lib/*.ts "$ags_root"/lib/gtk4/*.ts "${gir_types[@]}"

app_types="$root/@girs/ags-types/lib/gtk4/app.d.ts"
grep -Fq '"window-toggled": App["windowToggled"];' "$app_types"
sed -i 's|"window-toggled": App\["windowToggled"\];|"window-toggled": (window: Gtk.Window) => void;|' "$app_types"

exec tsc --noEmit --incremental false -p "$root/tsconfig.json"
