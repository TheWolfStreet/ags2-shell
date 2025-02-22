import { exec, GObject, property, register } from "astal"
import { App } from "astal/gtk3"

import { toggleWindow } from "../lib/utils"
import options from "../options"

const { sleep, reboot, logout, shutdown } = options.powermenu

export type Action = "sleep" | "reboot" | "logout" | "shutdown"
@register({ GTypeName: "Powermenu" })
export default class PowerMenu extends GObject.Object {
	static instance: PowerMenu
	static get_default() {
		if (!this.instance)
			this.instance = new PowerMenu()

		return this.instance
	}

	#title = ""
	#cmd = ""

	@property(String)
	get title() { return this.#title }

	action(action: Action) {
		[this.#cmd, this.#title] = {
			sleep: [sleep.get(), "Sleep"],
			reboot: [reboot.get(), "Reboot"],
			logout: [logout.get(), "Log Out"],
			shutdown: [shutdown.get(), "Shutdown"],
		}[action]
		this.notify("title")
		this.notify("cmd")
		if (App.get_window("powermenu")?.visible) {
			toggleWindow("powermenu")
		}
		toggleWindow("verification")
	}

	readonly exec = () => {
		toggleWindow("verification")
		exec(this.#cmd)
	}
}
