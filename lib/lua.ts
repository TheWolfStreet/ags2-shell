export function lua_string(value: string): string {
	const escaped = value.replace(/[\\"\x00-\x1f\x7f]/g, (char) =>
		char === "\\" || char === '"'
			? `\\${char}`
			: `\\${char.charCodeAt(0).toString().padStart(3, "0")}`,
	)
	return `"${escaped}"`
}
