function escape_lua_char(char: string): string {
	if (char === "\\" || char === '"') return `\\${char}`
	return `\\${char.charCodeAt(0).toString().padStart(3, "0")}`
}

export function lua_string(value: string): string {
	return `"${value.replace(/[\\"\x00-\x1f\x7f]/g, escape_lua_char)}"`
}
