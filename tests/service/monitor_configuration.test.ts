import assert from "node:assert/strict"
import test from "node:test"
import * as lua from "../../lib/lua.ts"
import { load_module } from "../load_module.ts"

const { format_monitor_command, is_monitor_settings } = await load_module(
	"service/monitor_configuration.ts",
	{ "$lib/lua": lua },
)

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

test("changing refresh rate preserves placement, scale, rotation, and mirror", () => {
	assert.equal(
		format_monitor_command(panel, { refresh_rate: 60 }),
		'eval hl.monitor({ output = "eDP-1", mode = "2560x1440@60", position = "-2560x120", scale = 1.5, transform = 1, mirror = "DP-1" })',
	)
})

test("disabling mirroring clears the merged rule's mirror instead of omitting it", () => {
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

test("monitor settings need a name and finite geometry", () => {
	assert.equal(is_monitor_settings(panel), true)
	assert.equal(is_monitor_settings({ ...panel, name: 1 }), false)
	assert.equal(is_monitor_settings({ ...panel, scale: Infinity }), false)
	assert.equal(is_monitor_settings({ ...panel, transform: "1" }), false)
	assert.equal(is_monitor_settings([panel]), false)
	assert.equal(is_monitor_settings(null), false)
})
