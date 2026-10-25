export function base_name(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1)
}

export function is_launcher_path(path: string): boolean {
	return path.toLowerCase().endsWith(".desktop")
}

export function describe_exit(code: number, signaled: boolean): string {
	return `${signaled ? "signal" : "status"} ${code}`
}
