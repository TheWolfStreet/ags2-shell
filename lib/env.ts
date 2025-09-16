import { createBinding } from "ags"
import { Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { createPoll, } from "ags/time"

import GLib from "gi://GLib"

import { ensurePath } from "./utils"

const APPNAME = "ags2-shell"

const env = {
	appName: APPNAME,
	username: GLib.get_user_name(),
	iconTheme: createBinding(app, "iconTheme").as(v => new Gtk.IconTheme({ themeName: v })),

	clock: createPoll<GLib.DateTime>(
		GLib.DateTime.new_now_local(),
		1000,
		() => GLib.DateTime.new_now_local()
	),

	uptime: createPoll<number>(
		0,
		60_000,
		"cat /proc/uptime",
		(line) => Math.round(parseInt(line.split(".")[0], 10) / 60)
	),

	paths: {
		home: GLib.get_home_dir(),
		avatar: `/var/lib/AccountsService/icons/${GLib.get_user_name()}`,
		cfg: `${GLib.get_user_config_dir()}/ags/`,
		cache: `${GLib.get_user_cache_dir()}/${APPNAME}/`,
		tmp: `${GLib.get_tmp_dir()}/${APPNAME}/`,
	},

	distro: {
		id: GLib.get_os_info("ID"),
		logo: GLib.get_os_info("LOGO") ?? undefined,
	},
	init: async () => {
		ensurePath(env.paths.tmp)
		ensurePath(env.paths.cache)
	}
}

export default env
