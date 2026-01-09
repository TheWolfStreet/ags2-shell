#!/usr/bin/env bash

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

cleanup() {
  pkill -P $$ 2>/dev/null
  pkill -f 'inotifywait.*scss' 2>/dev/null
}

trap cleanup EXIT INT TERM

CSS_FILE="style/compile/main.css"
if [ ! -f "$CSS_FILE" ] || [ -n "$(find style widget -name '*.scss' -newer "$CSS_FILE" 2>/dev/null)" ]; then
  ./style/compile/build.sh
fi

log_watch "Watching SCSS files for changes"
while inotifywait -qre modify,create,delete,close_write,moved_to --include '\.scss$' style widget 2>/dev/null; do
  ./style/compile/build.sh
done &

log_info "Starting shell"
ags run app.tsx "$@"
cleanup
