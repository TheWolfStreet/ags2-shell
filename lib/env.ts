// Stores app and user information and config, cache, and temporary paths.

import GLib from "gi://GLib"

const APPNAME = "ags2-shell"

function ensureDir(path: string) {
	GLib.mkdir_with_parents(path, 0o755)
}

const env = {
	appName: APPNAME,
	username: GLib.get_user_name(),

	paths: {
		home: GLib.get_home_dir(),
		avatar: `/var/lib/AccountsService/icons/${GLib.get_user_name()}`,
		cfg: `${GLib.get_user_config_dir()}/ags/`,
		cache: {
			base: `${GLib.get_user_cache_dir()}/${APPNAME}`,
			thumbnails: `${GLib.get_user_cache_dir()}/${APPNAME}/previews/thumbnails`,
		},
		tmp: `${GLib.get_tmp_dir()}/${APPNAME}/`,
		trash: `${GLib.get_user_data_dir()}/Trash/files`,
	},

	distro: {
		id: GLib.get_os_info("ID"),
		logo: GLib.get_os_info("LOGO") ?? undefined,
	},
	init: async () => {
		ensureDir(env.paths.tmp)
		ensureDir(env.paths.cache.base)
		ensureDir(env.paths.cache.thumbnails)
	}
}

export default env
