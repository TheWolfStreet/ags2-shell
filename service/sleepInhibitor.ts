import { createState } from "ags"

import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"

import app from "$lib/app"
import env from "$lib/env"
import { attempt, log_error } from "$lib/result"

const [inhibited, set_inhibited] = createState(false)
let lock: GioUnix.InputStream | null = null
let pending = false

function release() {
	const held = lock
	lock = null
	set_inhibited(false)
	if (held)
		log_error(
			attempt(() => held.close(null)),
			"sleepInhibitor.release: Failed to close inhibitor lock",
		)
}

function acquire() {
	pending = true
	Gio.DBus.system.call_with_unix_fd_list(
		"org.freedesktop.login1",
		"/org/freedesktop/login1",
		"org.freedesktop.login1.Manager",
		"Inhibit",
		new GLib.Variant("(ssss)", [
			"sleep:handle-lid-switch",
			env.appName,
			"Sleep inhibited from quick settings",
			"block",
		]),
		new GLib.VariantType("(h)"),
		Gio.DBusCallFlags.NONE,
		5000,
		null,
		null,
		(connection, response) => {
			pending = false
			const taken = attempt(() => {
				const [reply, descriptors] =
					connection!.call_with_unix_fd_list_finish(response)
				const [handle] = reply.deep_unpack<[number]>()
				const fd = descriptors?.steal_fds()[handle]
				if (fd === undefined) throw new Error("logind returned no lock")
				return new GioUnix.InputStream({ fd, close_fd: true })
			})
			if (!log_error(taken, "sleepInhibitor.acquire: Failed to inhibit sleep"))
				return
			lock = taken.value
			set_inhibited(true)
		},
	)
}

app.connect("shutdown", release)

export const sleep_inhibitor = {
	inhibited,
	toggle: () => {
		if (pending) return
		if (lock) {
			release()
			return
		}
		if (
			!log_error(
				attempt(acquire),
				"sleepInhibitor.acquire: Failed to call logind",
			)
		)
			pending = false
	},
}
