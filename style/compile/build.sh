#!/usr/bin/env bash

set -e

cwd="$(pwd)"

echo "Building AGS styles..."

widget_files=$(find "$cwd/widget" -name "*.scss" -type f)
file_count=$(echo "$widget_files" | wc -l)

echo "Found $file_count widget SCSS files"

widgets_index_file="$cwd/style/widgets.scss"
> "$widgets_index_file"

while IFS= read -r file; do
    relative_path="${file#$cwd/}"
    echo "@use '../$relative_path' as *;" >> "$widgets_index_file"
done <<< "$widget_files"

echo "Generated $widgets_index_file"

input_file="$cwd/style/compile/main.scss"
output_file="$cwd/style/compile/main.css"

if sass "$input_file" "$output_file" --style=expanded; then
    echo "Compiled -> $output_file"
else
    echo "SCSS compilation failed" >&2
    exit 1
fi
