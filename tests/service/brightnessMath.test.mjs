import assert from "node:assert/strict"
import test from "node:test"
import { brightness_target, parse_ddc_brightness } from "../../service/brightnessMath.ts"

test("brief DDC output parses current and maximum", () => {
	assert.deepEqual(parse_ddc_brightness("VCP 10 C 50 100"), { current: 50, maximum: 100 })
	assert.deepEqual(parse_ddc_brightness("VCP 10 C 127 255"), { current: 127, maximum: 255 })
	assert.equal(parse_ddc_brightness("VCP 10 ERR"), null)
	assert.equal(parse_ddc_brightness("VCP 10 C 300 255"), null)
	assert.equal(parse_ddc_brightness("VCP 10 C 0 0"), null)
})

test("percent writes use each display maximum and clamp invalid input", () => {
	assert.equal(brightness_target(0.5, 255), 128)
	assert.equal(brightness_target(0.5, 100), 50)
	assert.equal(brightness_target(1.3, 255), 255)
	assert.equal(brightness_target(Number.NaN, 255), 0)
	assert.equal(brightness_target(0.6), 60)
	assert.equal(brightness_target(0.5), 50)
})
