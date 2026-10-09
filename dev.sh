#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
instance_name=ags2-shell
ags_pid=
scss_watch_pid=
ts_watch_pid=

owns_instance() {
  local response kind pid group
  response=$(busctl --user --timeout=1s call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus GetConnectionUnixProcessID s "io.Astal.$instance_name" 2>/dev/null) || return 1
  read -r kind pid <<<"$response"
  [[ $kind == u && $pid =~ ^[0-9]+$ ]] || return 1
  group=$(ps -o pgid= -p "$pid" 2>/dev/null) || return 1
  group=${group//[[:space:]]/}
  [[ $group == "$ags_pid" ]]
}

group_alive() {
  [[ -n $ags_pid ]] && kill -0 -- "-$ags_pid" 2>/dev/null
}

stop_ags() {
  [[ -n $ags_pid ]] || return 0
  if owns_instance; then
    local response
    response=$(ags request -i "$instance_name" quit 2>&1) || printf 'Graceful quit request failed: %s\n' "$response" >&2
    if [[ $response == accepted ]]; then
      for attempt in {1..50}; do
        owns_instance || break
        sleep 0.1
      done
      if owns_instance; then
        printf 'Shell did not complete quit; preserving its running process and pending settings\n' >&2
        ags_pid=
        return 1
      fi
      for ((attempt = 0; attempt < 20; attempt++)); do
        group_alive || break
        sleep 0.1
      done
    fi
  fi
  if group_alive; then
    printf 'Stopping unresponsive development shell process group %s\n' "$ags_pid" >&2
    kill -TERM -- "-$ags_pid" 2>/dev/null || true
    for ((attempt = 0; attempt < 20; attempt++)); do
      group_alive || break
      sleep 0.1
    done
    if group_alive; then kill -KILL -- "-$ags_pid" 2>/dev/null || true; fi
  fi
  wait "$ags_pid" 2>/dev/null || true
  ags_pid=
}

cleanup() {
  trap - INT TERM EXIT
  if [[ -n $ts_watch_pid ]]; then
    kill "$ts_watch_pid" 2>/dev/null || true
    wait "$ts_watch_pid" 2>/dev/null || true
  fi
  if [[ -n $scss_watch_pid ]]; then
    pkill -P "$scss_watch_pid" 2>/dev/null || true
    kill "$scss_watch_pid" 2>/dev/null || true
    wait "$scss_watch_pid" 2>/dev/null || true
  fi
  stop_ags
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

build_once=false
shell_args=()
for arg in "$@"; do
  case $arg in
  -h | --help)
    printf 'Usage: %s [--build-once] [AGS options...]\n' "${0##*/}"
    exit 0
    ;;
  -b | --build-once) build_once=true ;;
  *) shell_args+=("$arg") ;;
  esac
done

for program in sass find sort mktemp cmp; do
  command -v "$program" >/dev/null || {
    printf 'Missing command: %s\n' "$program" >&2
    exit 1
  }
done
if ! $build_once; then
  for program in ags inotifywait pkill setsid busctl ps; do
    command -v "$program" >/dev/null || {
      printf 'Missing command: %s\n' "$program" >&2
      exit 1
    }
  done
fi

export AGS2SHELL_STYLES="$root"
cd "$root"
"$root/style/compile/build.sh"
if $build_once; then exit 0; fi

watch_events=close_write,create,delete,moved_to,moved_from
(
  while true; do
    if ! inotifywait -qre "$watch_events" --include '\.scss$' --exclude '(^|/)widgets\.scss$' "$root/style" "$root/widget"; then
      printf 'SCSS watcher failed\n' >&2
      exit 1
    fi
    if ! "$root/style/compile/build.sh"; then
      printf 'SCSS compilation failed; watching for corrections\n' >&2
    fi
  done
) &
scss_watch_pid=$!

while true; do
  if ! instances=$(ags list); then
    printf 'Could not check running AGS instances\n' >&2
    exit 1
  fi
  if grep -Fxq "$instance_name" <<<"$instances"; then
    printf 'AGS instance %s is already running; refusing to replace it\n' "$instance_name" >&2
    exit 1
  fi
  setsid ags run -g 4 shell/main.tsx "${shell_args[@]}" &
  ags_pid=$!
  inotifywait -qre "$watch_events" --include '\.(ts|tsx)$' \
    --exclude '(^|/)(node_modules|\.git|@girs)/' "$root" &
  ts_watch_pid=$!
  if ! wait "$ts_watch_pid"; then
    printf 'TypeScript watcher failed\n' >&2
    exit 1
  fi
  ts_watch_pid=
  stop_ags
done
