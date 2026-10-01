import GLib from "gi://GLib"
import { ensure_directory } from "$lib/files"
import { type Result } from "$lib/result"

const app_name = "ags2-shell"

const env = {
	appName: app_name,
	username: GLib.get_user_name(),

	paths: {
		home: GLib.get_home_dir(),
		avatar: `/var/lib/AccountsService/icons/${GLib.get_user_name()}`,
		cfg: `${GLib.get_user_config_dir()}/ags/`,
		cache: {
			base: `${GLib.get_user_cache_dir()}/${app_name}`,
		},
	},

	distro: {
		logo: GLib.get_os_info("LOGO") ?? undefined,
	},
	init: (): Result<void> => {
		return ensure_directory(env.paths.cache.base)
	}
}

export default env
