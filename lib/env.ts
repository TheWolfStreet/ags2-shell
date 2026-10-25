import GLib from "gi://GLib"
import { ensure_directory } from "$lib/files"
import { type result } from "$lib/result"

const app_name = "ags2-shell"
const username = GLib.get_user_name()

const env = {
	app_name,
	username,

	paths: {
		home: GLib.get_home_dir(),
		avatar: `/var/lib/AccountsService/icons/${username}`,
		cfg: `${GLib.get_user_config_dir()}/ags/`,
		cache: {
			base: `${GLib.get_user_cache_dir()}/${app_name}`,
		},
	},

	distro: {
		logo: GLib.get_os_info("LOGO") ?? undefined,
	},
	init: (): result<void> => ensure_directory(env.paths.cache.base),
}

export default env
