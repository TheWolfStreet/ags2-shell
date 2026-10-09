#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
index=$(mktemp "$root/style/.widgets.XXXXXXXX.tmp")
css=$(mktemp "$root/style/compile/.main.XXXXXXXX.css")
list=$(mktemp "$root/style/.widget-files.XXXXXXXX.tmp")
trap 'rm -f -- "$index" "$css" "$list"' EXIT

: >"$index"
find "$root/widget" -name '*.scss' -type f -print0 | LC_ALL=C sort -z >"$list"
count=0
while IFS= read -r -d '' file; do
  path=${file#"$root"/}
  printf "@use '../%s' as *;\n" "$path" >>"$index"
  ((count += 1))
done <"$list"

if ! cmp -s "$index" "$root/style/widgets.scss"; then
  mv -f -- "$index" "$root/style/widgets.scss"
fi
printf 'Indexing %s widget SCSS files\n' "$count"
sass "$root/style/compile/main.scss" "$css" --style=expanded --quiet --no-source-map --no-error-css
mv -f -- "$css" "$root/style/compile/main.css"
printf 'Compiled main.css\n'
