import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const sway = process.env.SWAY_HEADLESS_BIN ||
	(spawnSync("which", ["sway-unwrapped"], { encoding: "utf8" }).stdout || "").trim()
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/tXcAAAAASUVORK5CYII=",
	"base64",
)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

test("detached screenshot PNG provider survives its sender group", { timeout: 20_000 }, async t => {
	if (!sway) return t.skip("sway-unwrapped is not available")
	const root = mkdtempSync(join(tmpdir(), "ags-clipboard-"))
	const runtime = join(root, "runtime")
	const home = join(root, "home")
	mkdirSync(runtime, { mode: 0o700 })
	mkdirSync(home, { mode: 0o700 })
	const config = join(root, "sway.conf")
	const image = join(root, "one-pixel.png")
	writeFileSync(config, "output HEADLESS-1 resolution 640x480\n")
	writeFileSync(image, png)
	const env = { ...process.env, XDG_RUNTIME_DIR: runtime, HOME: home,
		WLR_BACKENDS: "headless", WLR_RENDERER: "pixman", WLR_LIBINPUT_NO_DEVICES: "1" }
	delete env.WAYLAND_DISPLAY
	delete env.WAYLAND_SOCKET
	delete env.SWAYSOCK
	delete env.HYPRLAND_INSTANCE_SIGNATURE
	delete env.DBUS_SESSION_BUS_ADDRESS
	delete env.DISPLAY
	let log = ""
	const compositor = spawn(sway, ["-c", config], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
	compositor.on("error", error => { log = (log + error).slice(-8192) })
	compositor.stdout.on("data", chunk => { log = (log + chunk).slice(-8192) })
	compositor.stderr.on("data", chunk => { log = (log + chunk).slice(-8192) })
	let sender
	try {
		const socket_name = () => readdirSync(runtime).find(name =>
			/^wayland-\d+$/.test(name) && statSync(join(runtime, name)).isSocket())
		const deadline = Date.now() + 6000
		while (!socket_name() && Date.now() < deadline && compositor.exitCode === null) await wait(50)
		const socket = socket_name()
		assert.ok(socket, `headless Sway did not start: ${log}`)
		const isolated = { ...env, WAYLAND_DISPLAY: socket }
		const command = `setsid wl-copy --type image/png < ${quote(image)}`
		sender = spawn("bash", ["-c",
			`bash -c ${quote(command)}; code=$?; printf 'copy-status=%s\n' "$code"; sleep 30`],
			{ env: isolated, detached: true, stdio: ["ignore", "pipe", "pipe"] })
		let sender_error = ""
		sender.stderr.on("data", chunk => { sender_error = (sender_error + chunk).slice(-4096) })
		const status = await new Promise((resolve, reject) => {
			let output = ""
			const deadline = setTimeout(() => reject(new Error(`sender did not report its exit: ${sender_error}`)), 5000)
			sender.stdout.on("data", chunk => {
				output += chunk
				const match = /copy-status=(\d+)/.exec(output)
				if (match) {
					clearTimeout(deadline)
					resolve(Number(match[1]))
				}
			})
			sender.once("exit", () => {
				clearTimeout(deadline)
				reject(new Error(`sender exited before reporting its status: ${sender_error}`))
			})
		})
		assert.equal(status, 0, `clipboard command failed: ${sender_error}`)
		const paste = () => spawnSync("wl-paste", ["--type", "image/png"],
			{ env: isolated, timeout: 2000, maxBuffer: 1024 * 1024 })
		let received
		const paste_deadline = Date.now() + 4000
		do {
			received = paste()
			if (received.status === 0) break
			await wait(50)
		} while (Date.now() < paste_deadline)
		assert.equal(received.status, 0, `PNG paste unavailable: ${received.stderr}; ${log}`)
		assert.deepEqual(received.stdout, png)
		const stopped = once(sender, "exit")
		process.kill(-sender.pid, "SIGTERM")
		await Promise.race([stopped, wait(1000)])
		assert.equal(sender.signalCode, "SIGTERM", "sender group did not terminate")
		received = paste()
		assert.equal(received.status, 0, `PNG provider died with sender group: ${received.stderr}`)
		assert.deepEqual(received.stdout, png)
		spawnSync("wl-copy", ["--clear"], { env: isolated, timeout: 2000 })
	} finally {
		if (sender?.pid) {
			try { process.kill(-sender.pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
		}
		if (compositor.pid) {
			try { process.kill(-compositor.pid, "SIGTERM") } catch (error) { if (error.code !== "ESRCH") throw error }
			if (compositor.exitCode === null && compositor.signalCode === null)
				await Promise.race([once(compositor, "exit"), wait(1500)])
			if (compositor.exitCode === null && compositor.signalCode === null) {
				try { process.kill(-compositor.pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
			}
		}
		rmSync(root, { recursive: true, force: true })
	}
})
