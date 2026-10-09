import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
	accessSync,
	chmodSync,
	constants,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const shell_quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const stub_source = `import { readFileSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
const [flag, module_path, ...args] = process.argv.slice(2)
if (flag !== "-m") process.exit(2)
console.log(JSON.stringify({ module_path, args, mode: statSync(module_path).mode & 0o777, hash: createHash("sha256").update(readFileSync(module_path)).digest("hex") }))
`

function run_bundle(launcher, stub, runtime) {
	accessSync(launcher, constants.X_OK)
	const source = readFileSync(launcher, "utf8")
	const payload = source.match(/^([A-Za-z0-9+/=]+)\nEOF$/m)
	assert.ok(payload, "AGS bundle must contain an encoded module")
	const expected_hash = createHash("sha256")
		.update(Buffer.from(payload[1], "base64"))
		.digest("hex")
	const command = /LD_PRELOAD="[^"\n]*" \S+\/gjs -m "\$file" "\$@"/
	assert.match(source, command)
	const copied = join(runtime, "extracted launcher")
	writeFileSync(
		copied,
		source.replace(
			command,
			`${shell_quote(process.execPath)} ${shell_quote(stub)} -m "$file" "$@"`,
		),
		{ mode: 0o700 },
	)
	chmodSync(copied, 0o700)

	const hostile = join(runtime, "dmFyIF-ags.js")
	writeFileSync(hostile, "do not overwrite", { mode: 0o600 })
	const args = [
		"wallpaper with spaces.png",
		"literal $HOME; $(false)",
		"apostrophe's & backslash\\",
	]
	const result = spawnSync(copied, args, {
		encoding: "utf8",
		env: { ...process.env, XDG_RUNTIME_DIR: runtime },
	})
	assert.equal(result.status, 0, result.stderr)
	const report = JSON.parse(result.stdout)
	assert.equal(report.hash, expected_hash)
	assert.equal(report.mode, 0o600)
	assert.deepEqual(report.args, args)
	assert.equal(
		report.module_path.startsWith(join(runtime, "ags2-shell.")),
		true,
	)
	assert.equal(readFileSync(hostile, "utf8"), "do not overwrite")
	assert.deepEqual(
		readdirSync(runtime).sort(),
		["dmFyIF-ags.js", "extracted launcher"].sort(),
	)
}

test(
	"packaged launchers extract privately, preserve arguments and clean up",
	{ skip: !process.env.BUNDLED_MAIN },
	() => {
		const stage = mkdtempSync(join(tmpdir(), "ags2-shell-package-test."))
		try {
			const stub = join(stage, "stub.mjs")
			writeFileSync(stub, stub_source)
			for (const launcher of [
				process.env.BUNDLED_MAIN,
				process.env.BUNDLED_WALLPAPER,
			]) {
				const runtime = join(
					stage,
					`runtime ${launcher.includes("wallpaper") ? "wallpaper" : "main"}`,
				)
				mkdirSync(runtime)
				run_bundle(launcher, stub, runtime)
			}
		} finally {
			rmSync(stage, { recursive: true, force: true })
		}
	},
)

test("native installer launchers extract privately, preserve arguments and clean up", () => {
	const stage = mkdtempSync(join(tmpdir(), "ags2-shell-native-test."))
	try {
		const prefix = join(stage, "prefix with spaces & $HOME ' quote")
		const result = spawnSync(
			"bash",
			[join(root, "scripts/install-native.sh")],
			{
				encoding: "utf8",
				env: { ...process.env, PREFIX: prefix, TMPDIR: stage },
			},
		)
		assert.equal(result.status, 0, result.stderr)
		const stub = join(stage, "stub.mjs")
		writeFileSync(stub, stub_source)
		for (const [name, launcher] of [
			["main", join(prefix, "bin/ags2-shell")],
			["wallpaper", join(prefix, "libexec/ags2-shell-wallpaper")],
		]) {
			const runtime = join(stage, `runtime ${name}`)
			mkdirSync(runtime)
			run_bundle(launcher, stub, runtime)
		}
	} finally {
		rmSync(stage, { recursive: true, force: true })
	}
})
