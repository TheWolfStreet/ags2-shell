const decode_steps = [32, 64, 128, 256, 512]

export function decode_size(size: number) {
	return decode_steps.find((step) => step >= size) ?? decode_steps.at(-1)!
}
