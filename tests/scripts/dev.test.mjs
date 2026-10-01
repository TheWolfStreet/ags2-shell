import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const source = new URL("../../dev.sh", import.meta.url)
const bash_path = execFileSync("which", ["bash"], { encoding: "utf8" }).trim()

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ags-dev-test-"))
	const state = join(root, "state")
	mkdirSync(state)
	mkdirSync(join(root, "bin"))
	mkdirSync(join(root, "style/compile"), { recursive: true })
	mkdirSync(join(root, "widget"))
	copyFileSync(source, join(root, "dev.sh"))
	writeFileSync(join(root, "style/compile/build.sh"), `#!${bash_path}\nexit 0\n`, { mode: 0o755 })
	writeFileSync(join(root, "bin/ags"), `#!${bash_path}
case "$1" in
  list)
    if [[ -f $TEST_STATE/owner ]]; then printf 'ags2-shell\n'; fi
    ;;
  run)
    printf '%s' "$BASHPID" > "$TEST_STATE/group"
    (
      trap 'rm -f "$TEST_STATE/owner"; exit 0' TERM INT
      printf '%s' "$BASHPID" > "$TEST_STATE/owner"
      while true; do sleep 0.1; done
    ) &
    wait "$!"
    ;;
  request)
    printf 'request\n' >> "$TEST_STATE/requests"
    if [[ -f $TEST_STATE/owner ]]; then
      if [[ ! -v HOLD_QUIT ]]; then kill -TERM "$(<"$TEST_STATE/owner")"; fi
      printf 'accepted\n'
    fi
    ;;
esac
`, { mode: 0o755 })
	writeFileSync(join(root, "bin/busctl"), `#!${bash_path}
if [[ -f $TEST_STATE/owner && ! -f $TEST_STATE/no_owner ]]; then
  printf 'u %s\n' "$(<"$TEST_STATE/owner")"
else
  exit 1
fi
`, { mode: 0o755 })
	writeFileSync(join(root, "bin/inotifywait"), `#!${bash_path}
for arg in "$@"; do
  if [[ $arg == *scss* ]]; then exec sleep 60; fi
done
until [[ -f $TEST_STATE/trigger ]]; do sleep 0.02; done
rm -f "$TEST_STATE/trigger"
`, { mode: 0o755 })
	return { root, state, env: { ...process.env, TEST_STATE: state, PATH: `${join(root, "bin")}:${process.env.PATH}` } }
}

async function until(check) {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (check()) return
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
	throw new Error("Timed out waiting for development shell")
}

function alive(pid) {
	try { process.kill(pid, 0); return true }
	catch { return false }
}

async function stopped(child) {
	if (child.exitCode !== null || child.signalCode !== null) return
	await new Promise((resolve) => child.once("exit", resolve))
}

async function verify_reload(no_owner) {
	const { root, state, env } = fixture()
	if (no_owner) writeFileSync(join(state, "no_owner"), "")
	const dev = spawn("bash", [join(root, "dev.sh")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
	let output = ""
	dev.stdout.on("data", (chunk) => { output += chunk })
	dev.stderr.on("data", (chunk) => { output += chunk })
	let group = 0
	let second = 0
	try {
		await until(() => existsSync(join(state, "owner"))).catch((error) => {
			throw new Error(`${error.message}: ${output}`)
		})
		const first = Number(readFileSync(join(state, "owner"), "utf8"))
		group = Number(readFileSync(join(state, "group"), "utf8"))
		writeFileSync(join(state, "trigger"), "")
		await until(() => {
			try { return Number(readFileSync(join(state, "owner"), "utf8")) !== first }
			catch (error) {
				if (error.code === "ENOENT") return false
				throw error
			}
		})
		second = Number(readFileSync(join(state, "owner"), "utf8"))
		await until(() => !alive(first))
		assert.equal(existsSync(join(state, "requests")), !no_owner)
	} finally {
		dev.kill("SIGTERM")
		try {
			await Promise.race([stopped(dev), new Promise((resolve) => setTimeout(resolve, 1000))])
			const latest_group = existsSync(join(state, "group"))
				? Number(readFileSync(join(state, "group"), "utf8")) : 0
			for (const owned_group of new Set([group, latest_group])) {
				if (owned_group) { try { process.kill(-owned_group, "SIGKILL") } catch {} }
			}
			if (dev.exitCode === null && dev.signalCode === null) dev.kill("SIGKILL")
			await stopped(dev)
			if (second) await until(() => !alive(second))
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	}
}

test("reload quits its own GJS child and leaves no orphan", async () => {
	await verify_reload(false)
})

test("unavailable D-Bus ownership falls back to its own process group", async () => {
	await verify_reload(true)
})

test("an acknowledged quit that cannot finish preserves the running instance", async () => {
	const { root, state, env } = fixture()
	const dev = spawn("bash", [join(root, "dev.sh")], {
		cwd: root, env: { ...env, HOLD_QUIT: "1" }, stdio: ["ignore", "pipe", "pipe"],
	})
	let output = ""
	dev.stderr.on("data", (chunk) => { output += chunk })
	let group = 0
	try {
		await until(() => existsSync(join(state, "owner")))
		const owner = Number(readFileSync(join(state, "owner"), "utf8"))
		group = Number(readFileSync(join(state, "group"), "utf8"))
		writeFileSync(join(state, "trigger"), "")
		await until(() => dev.exitCode !== null || dev.signalCode !== null)
		assert.equal(alive(owner), true)
		assert.match(output, /preserving its running process/)
	} finally {
		dev.kill("SIGTERM")
		if (group) { try { process.kill(-group, "SIGKILL") } catch {} }
		await stopped(dev)
		rmSync(root, { recursive: true, force: true })
	}
})

test("an unrelated registered instance is never requested or signaled", async () => {
	const { root, state, env } = fixture()
	const foreign = spawn("sleep", ["20"], { detached: true, stdio: "ignore" })
	writeFileSync(join(state, "owner"), String(foreign.pid))
	const dev = spawn("bash", [join(root, "dev.sh")], { cwd: root, env, stdio: "ignore" })
	try {
		await stopped(dev)
		assert.equal(alive(foreign.pid), true)
		assert.equal(existsSync(join(state, "requests")), false)
	} finally {
		dev.kill("SIGTERM")
		foreign.kill("SIGTERM")
		await stopped(foreign)
		rmSync(root, { recursive: true, force: true })
	}
})
