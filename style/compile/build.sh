#!/usr/bin/env bash

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RESET='\033[0m'

log_build() { echo -e "${CYAN}▸${RESET} $1"; }
log_done() { echo -e "${GREEN}✓${RESET} $1"; }

cwd="$(pwd)"

widget_files=$(find "$cwd/widget" -name "*.scss" -type f)
file_count=$(echo "$widget_files" | wc -l)

log_build "Indexing $file_count widget SCSS files"

widgets_index_file="$cwd/style/widgets.scss"
> "$widgets_index_file"

while IFS= read -r file; do
    relative_path="${file#$cwd/}"
    echo "@use '../$relative_path' as *;" >> "$widgets_index_file"
done <<< "$widget_files"

input_file="$cwd/style/compile/main.scss"
output_file="$cwd/style/compile/main.css"

if sass "$input_file" "$output_file" --style=expanded --quiet; then
    log_done "Compiled main.css"
else
    echo -e "\033[0;31m✗\033[0m SCSS compilation failed" >&2
    exit 1
fi
