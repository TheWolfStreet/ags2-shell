// Finds external DDC displays and reads or changes their brightness.

import { execAsync } from "ags/process"

export async function discoverExternalDisplays(): Promise<number[]> {
	const output = await execAsync(["ddcutil", "detect"]).catch(() => "")
	const displays: number[] = []

	for (const block of output.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean)) {
		const displayMatch = block.match(/^Display\s+(\d+)/m)
		if (!displayMatch) continue

		const connector = block.match(/DRM connector:\s+([^\n]+)/i)?.[1]?.toLowerCase() ?? ""
		if (!connector.includes("edp") && !connector.includes("lvds"))
			displays.push(Number(displayMatch[1]))
	}

	return displays
}

export async function readExternalBrightness(display: number): Promise<number | null> {
	const output = await execAsync([
		"ddcutil", "getvcp", "10", "--brief", "--display", String(display),
	]).catch(() => "")
	const match = output.match(/current value =\s*(\d+)/i) || output.match(/\b10\s+(\d+)\s+\d+\b/)
	if (!match) return null

	const value = Number(match[1])
	return Number.isFinite(value) ? value : null
}

export async function writeExternalBrightness(displays: readonly number[], target: number): Promise<boolean> {
	let writeSucceeded = false
	for (const display of displays) {
		const succeeded = await execAsync([
			"ddcutil", "setvcp", "10", String(target), "--display", String(display), "--noverify",
		]).then(() => true).catch(() => false)
		writeSucceeded = writeSucceeded || succeeded
	}
	return writeSucceeded
}
