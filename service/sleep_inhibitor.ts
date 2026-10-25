import { createState } from "ags"

import Gio from "gi://Gio"
import GioUnix from "gi://GioUnix"
import GLib from "gi://GLib"

import app from "$lib/app"
import env from "$lib/env"
import { attempt, err, log_error, type result } from "$lib/result"

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
			"sleep_inhibitor.release: Failed to close inhibitor lock",
		)
}

function take_lock(
	connection: Gio.DBusConnection,
	response: Gio.AsyncResult,
): result<GioUnix.InputStream> {
	const finished = attempt(() =>
		connection.call_with_unix_fd_list_finish(response),
	)
	if (!finished.ok) return finished

	const [reply, descriptors] = finished.value
	const [handle] = reply.deep_unpack<[number]>()
	const fd = descriptors?.steal_fds()[handle]
	if (fd === undefined) return err(new Error("logind returned no lock"))
	return attempt(() => new GioUnix.InputStream({ fd, close_fd: true }))
}

function hold(connection: Gio.DBusConnection, response: Gio.AsyncResult) {
	pending = false
	const taken = take_lock(connection, response)
	if (!log_error(taken, "sleep_inhibitor.acquire: Failed to inhibit sleep"))
		return
	lock = taken.value
	set_inhibited(true)
}

function request_lock(): result<void> {
	return attempt(() =>
		Gio.DBus.system.call_with_unix_fd_list(
			"org.freedesktop.login1",
			"/org/freedesktop/login1",
			"org.freedesktop.login1.Manager",
			"Inhibit",
			new GLib.Variant("(ssss)", [
				"sleep:handle-lid-switch",
				env.app_name,
				"Sleep inhibited from quick settings",
				"block",
			]),
			new GLib.VariantType("(h)"),
			Gio.DBusCallFlags.NONE,
			5000,
			null,
			null,
			(connection, response) => hold(connection!, response),
		),
	)
}

function acquire() {
	pending = true
	const requested = request_lock()
	if (log_error(requested, "sleep_inhibitor.acquire: Failed to call logind"))
		return
	pending = false
}

function toggle() {
	if (pending) return
	if (lock) release()
	else acquire()
}

app.connect("shutdown", release)

export const sleep_inhibitor = { inhibited, toggle }
