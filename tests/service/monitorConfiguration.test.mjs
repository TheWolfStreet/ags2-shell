import assert from "node:assert/strict"
import test from "node:test"
import { format_monitor_command } from "../../service/monitorConfiguration.ts"

const panel = {
	name: "eDP-1", width: 2560, height: 1440, refreshRate: 144,
	x: -2560, y: 120, scale: 1.5, transform: 1, mirrorOf: "DP-1",
}

test("changing refresh rate preserves placement, scale, rotation, and mirror", () => {
	assert.equal(format_monitor_command(panel, { refresh_rate: 60 }),
		"keyword monitor eDP-1,2560x1440@60,-2560x120,1.5,transform,1,mirror,DP-1")
})

test("disabling mirroring restores the original target configuration", () => {
	assert.equal(format_monitor_command(panel, { mirror: "none" }),
		"keyword monitor eDP-1,2560x1440@144,-2560x120,1.5,transform,1")
	assert.equal(format_monitor_command({ ...panel, mirrorOf: "none" }, { mirror: "HDMI-A-1" }),
		"keyword monitor eDP-1,2560x1440@144,-2560x120,1.5,transform,1,mirror,HDMI-A-1")
})
