import Gio from "gi://Gio"
import GLib from "gi://GLib"

function check(condition, message) {
	if (!condition) throw new Error(message)
}

function remove_tree(entry) {
	if (!entry.query_exists(null)) return
	const info = entry.query_info("standard::type", Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
	if (info.get_file_type() === Gio.FileType.DIRECTORY) {
		const children = entry.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
		try {
			let child
			while ((child = children.next_file(null))) remove_tree(entry.get_child(child.get_name()))
		} finally { children.close(null) }
	}
	entry.delete(null)
}

const temp_path = GLib.dir_make_tmp("ags2-native-XXXXXX")
const root = Gio.File.new_for_path(temp_path)
const folder = root.get_child("folder")
const file = folder.get_child("sample.txt")

GLib.setenv("HOME", temp_path, true)
GLib.setenv("XDG_RUNTIME_DIR", temp_path, true)
GLib.unsetenv("HYPRLAND_INSTANCE_SIGNATURE")

try {
	await import("../lib/native.ts")
	const Gdk = (await import("gi://Gdk?version=4.0")).default
	check(typeof Gio.File.prototype.trash_async === "function", "trash_async override missing")
	check(typeof Gdk.Clipboard.prototype.read_async === "function", "clipboard promise override missing")
	check(typeof Gdk.Drop.prototype.read_async === "function", "drop promise override missing")

	const created = folder.make_directory_async(GLib.PRIORITY_DEFAULT, null)
	check(created instanceof Promise, "make_directory_async did not return a promise")
	check(await created, "make_directory_async returned false")
	file.replace_contents("abc", null, false, Gio.FileCreateFlags.PRIVATE, null)

	const info_result = file.query_info_async("standard::size", Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null)
	check(info_result instanceof Promise, "query_info_async did not return a promise")
	check((await info_result).get_size() === 3, "query_info_async returned the wrong file")
	await new Promise((resolve, reject) => {
		file.query_info_async("standard::size", Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null, (source, result) => {
			try {
				check(source.query_info_finish(result).get_size() === 3, "callback query returned the wrong file")
				resolve()
			} catch (error) { reject(error) }
		})
	})

	const enumerator_result = folder.enumerate_children_async("standard::name", Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null)
	check(enumerator_result instanceof Promise, "enumerate_children_async did not return a promise")
	const enumerator = await enumerator_result
	const batch_result = enumerator.next_files_async(10, GLib.PRIORITY_DEFAULT, null)
	check(batch_result instanceof Promise, "next_files_async did not return a promise")
	const batch = await batch_result
	check(batch.length === 1 && batch[0].get_name() === "sample.txt", "enumeration lost the child")
	check(await enumerator.close_async(GLib.PRIORITY_DEFAULT, null), "enumerator close failed")

	const stream = file.read(null)
	const bytes_result = stream.read_bytes_async(3, GLib.PRIORITY_DEFAULT, null)
	check(bytes_result instanceof Promise, "read_bytes_async did not return a promise")
	check((await bytes_result).get_size() === 3, "read_bytes_async returned the wrong contents")
	check(await stream.close_async(GLib.PRIORITY_DEFAULT, null), "stream close failed")

	const Hyprland = (await import("gi://AstalHyprland")).default
	const hyprland = new Hyprland.Hyprland()
	const message = hyprland.message_async("j/monitors")
	check(message instanceof Promise, "Hyprland message_async did not return a promise")
	let deadline = 0
	const timed_out = new Promise((resolve, reject) => {
		deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
			deadline = 0
			reject(new Error("Hyprland message_async did not settle"))
			return GLib.SOURCE_REMOVE
		})
	})
	let rejected = false
	let response = null
	try { response = await Promise.race([message, timed_out]) }
	catch (error) {
		if (String(error).includes("did not settle")) throw error
		rejected = true
	} finally { if (deadline) GLib.Source.remove(deadline) }
	check(rejected || response === "", `isolated Hyprland request returned ${String(response)}`)

	const removed = file.delete_async(GLib.PRIORITY_DEFAULT, null)
	check(removed instanceof Promise, "delete_async did not return a promise")
	check(await removed, "delete_async returned false")
	check(await folder.delete_async(GLib.PRIORITY_DEFAULT, null), "folder delete failed")
	print("native smoke passed")
} finally {
	remove_tree(root)
}
