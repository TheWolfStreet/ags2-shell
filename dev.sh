#!/usr/bin/env bash
# Starts development mode and reloads changed source and style files.
set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
RESET='\033[0m'

log_info() { echo -e "${BLUE}▸${RESET} $1"; }
log_success() { echo -e "${GREEN}✓${RESET} $1"; }
log_watch() { echo -e "${YELLOW}◉${RESET} $1"; }
log_error() { echo -e "${RED}✗${RESET} $1"; }

show_help() {
  cat << EOF
Usage: $(basename "$0") [OPTION]...

Run AGS shell with hot-reload for SCSS and TS/TSX files.

Options:
  -b, --build-once    build styles once and exit
  -h, --help          display this help and exit

With no options, builds styles if needed, watches for file changes, and runs shell.
EOF
  exit 0
}

CLEANED_UP=false
cleanup() {
  $CLEANED_UP && exit 0
  CLEANED_UP=true
  log_info "Shutting down..."
  [ -n "$AGS_PID" ] && kill "$AGS_PID" 2>/dev/null || true
  timeout 1 ags quit -i "$INSTANCE_NAME" 2>/dev/null || true
  if [ -n "$SCSS_WATCH_PID" ]; then
    kill "$SCSS_WATCH_PID" 2>/dev/null || true
    wait "$SCSS_WATCH_PID" 2>/dev/null || true
  fi
  pkill -f 'inotifywait' 2>/dev/null || true
  [ -n "$AGS_PID" ] && kill -9 "$AGS_PID" 2>/dev/null || true
  exit 0
}

trap cleanup INT TERM

CSS_FILE="style/compile/main.css"
INSTANCE_NAME="ags2-shell"
AGS_PID=""
SCSS_WATCH_PID=""

BUILD_ONCE=false
SHELL_ARGS=()

for arg in "$@"; do
  case $arg in
    -h|--help)
      show_help
      ;;
    -b|--build-once)
      BUILD_ONCE=true
      ;;
    *)
      SHELL_ARGS+=("$arg")
      ;;
  esac
done

if [ ! -f "$CSS_FILE" ] || [ -n "$(find style widget -name '*.scss' -newer "$CSS_FILE" 2>/dev/null)" ]; then
  ./style/compile/build.sh
fi

if [ "$BUILD_ONCE" = true ]; then
  log_success "Styles built"
  exit 0
fi

watch_dirs="style widget"
watch_events="modify,create,delete,close_write,moved_to"
watch_pattern='\.scss$'

log_watch "Watching SCSS files for changes"
while inotifywait -qre "$watch_events" --include "$watch_pattern" $watch_dirs 2>/dev/null; do
  ./style/compile/build.sh
done &
SCSS_WATCH_PID=$!

log_watch "Watching TS/TSX files for changes"
while true; do
  log_info "Starting shell"
  ags run shell/main.tsx "${SHELL_ARGS[@]}" &
  AGS_PID=$!

  inotifywait -qre "$watch_events" --include '\.(ts|tsx)$' @./@girs . 2>/dev/null || true

  log_info "TS/TSX change detected, restarting shell"
  ags quit -i "$INSTANCE_NAME" 2>/dev/null || kill $AGS_PID 2>/dev/null || true
  sleep 1
done

cleanup
