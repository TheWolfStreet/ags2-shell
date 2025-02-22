import { Variable, GLib } from "astal"
import { App } from "astal/gtk3"

import { ensureDir } from "./utils"

App.instanceName = "ags-main"

export const env = {
	clock: Variable(GLib.DateTime.new_now_local()),
	uptime: Variable(0),
	username: GLib.get_user_name(),
	paths: {
		avatar: `/var/lib/AccountsService/icons/${GLib.get_user_name()}`,
		home: GLib.get_home_dir(),
		tmp: `${GLib.get_tmp_dir()}/${App.instanceName}`,
		cache: `${GLib.get_user_cache_dir()}/${App.instanceName}`,
	},
	distro: {
		id: GLib.get_os_info("ID"),
		logo: GLib.get_os_info("LOGO"),
	},
}

ensureDir(env.paths.tmp)
ensureDir(env.paths.cache)

env.uptime.poll(60_000, "cat /proc/uptime", (line: string) => {
	return Number.parseInt(line.split(".")[0]) / 60
})
env.clock.poll(1000, () => GLib.DateTime.new_now_local())
