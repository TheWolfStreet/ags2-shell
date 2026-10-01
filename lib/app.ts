import "./native"
import upstream_app from "ags/gtk4/app"
import { Gtk } from "ags/gtk4"
import GObject, { register } from "ags/gobject"

const UpstreamApplication = upstream_app.constructor as new () => typeof upstream_app & GObject.Object

@register()
class ShellApplication extends UpstreamApplication {
	declare before_quit?: () => Promise<boolean>
	#quit_pending: Promise<void> | null = null

	override quit(code = 0): void {
		if (this.#quit_pending) return
		this.#quit_pending = Promise.resolve().then(() => this.finish_quit(code))
	}

	private async finish_quit(code: number): Promise<void> {
		let handler = 0
		try {
			if (this.before_quit && !await this.before_quit()) {
				this.#quit_pending = null
				return
			}
			handler = this.connect_after("shutdown", () => {
				this.disconnect(handler)
				handler = 0
				super.quit(code)
			})
			Gtk.Application.prototype.quit.call(this)
		} catch (error) {
			if (handler) this.disconnect(handler)
			this.#quit_pending = null
			console.error("shell.quit: Failed to quit application", error)
		}
	}
}

const app = new ShellApplication()
export default app
