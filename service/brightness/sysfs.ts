// Finds the first device listed in a system folder.

import Gio from "gi://Gio"

import { attempt } from "$lib/result"

export function firstDevice(directory: string): string {
	const result = attempt(() => {
		const enumerator = Gio.File.new_for_path(directory).enumerate_children(
			"standard::name",
			Gio.FileQueryInfoFlags.NONE,
			null,
		)
		const names: string[] = []
		let info: Gio.FileInfo | null
		while ((info = enumerator.next_file(null)) !== null)
			names.push(info.get_name())
		enumerator.close(null)
		return names.sort()[0] ?? ""
	})
	return result.ok ? result.value : ""
}
