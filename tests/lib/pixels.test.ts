import assert from "node:assert/strict"
import test from "node:test"
import { decode_size } from "../../lib/pixels.ts"

test("decode sizes snap up to a fixed step so nearby scales share one decode", () => {
	assert.deepEqual(
		[1, 16, 33, 48, 64, 65, 140, 286, 512, 900].map(decode_size),
		[32, 32, 64, 64, 64, 128, 256, 512, 512, 512],
	)
})
