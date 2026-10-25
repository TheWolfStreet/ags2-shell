import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import test from "node:test"
import { SourceTextModule, SyntheticModule } from "node:vm"
import * as lua from "../../lib/lua.ts"

async function load() {
	const module = new SourceTextModule(
		stripTypeScriptTypes(
			readFileSync(
				new URL("../../service/monitorConfiguration.ts", import.meta.url),
				"utf8",
			),
		),
	)
	await module.link((name) => {
		assert.equal(name, "$lib/lua")
		return new SyntheticModule(Object.keys(lua), function () {
			for (const [key, value] of Object.entries(lua)) this.setExport(key, value)
		})
	})
	await module.evaluate()
	return (module.namespace as Record<string, any>).format_monitor_command
}

const panel = {
	name: "eDP-1",
	width: 2560,
	height: 1440,
	refreshRate: 144,
	x: -2560,
	y: 120,
	scale: 1.5,
	transform: 1,
	mirrorOf: "DP-1",
}

test("changing refresh rate preserves placement, scale, rotation, and mirror", async () => {
	const format_monitor_command = await load()
	assert.equal(
		format_monitor_command(panel, { refresh_rate: 60 }),
		'eval hl.monitor({ output = "eDP-1", mode = "2560x1440@60", position = "-2560x120", scale = 1.5, transform = 1, mirror = "DP-1" })',
	)
})

test("disabling mirroring clears the merged rule's mirror instead of omitting it", async () => {
	const format_monitor_command = await load()
	assert.equal(
		format_monitor_command(panel, { mirror: "none" }),
		'eval hl.monitor({ output = "eDP-1", mode = "2560x1440@144", position = "-2560x120", scale = 1.5, transform = 1, mirror = "none" })',
	)
	assert.equal(
		format_monitor_command(
			{ ...panel, mirrorOf: null, transform: 0 },
			{ refresh_rate: 120 },
		),
		'eval hl.monitor({ output = "eDP-1", mode = "2560x1440@120", position = "-2560x120", scale = 1.5, transform = 0, mirror = "none" })',
	)
	assert.equal(
		format_monitor_command(
			{ ...panel, mirrorOf: "none" },
			{ mirror: "HDMI-A-1" },
		),
		'eval hl.monitor({ output = "eDP-1", mode = "2560x1440@144", position = "-2560x120", scale = 1.5, transform = 1, mirror = "HDMI-A-1" })',
	)
})

test("Lua strings escape quotes, backslashes, and control bytes without touching UTF-8", () => {
	assert.equal(lua.lua_string('a"b\\c'), '"a\\"b\\\\c"')
	assert.equal(lua.lua_string("line\nnext\x7f"), '"line\\010next\\127"')
	assert.equal(lua.lua_string("\x01" + "2"), '"\\0012"')
	assert.equal(lua.lua_string("café ✓"), '"café ✓"')
})
