import Auth from "gi://AstalAuth"
import { App, Gtk } from "astal/gtk3"
import { execAsync } from "astal"

const { CENTER } = Gtk.Align
const auth = new Auth.Pam()

export default () => (
	<box hexpand vexpand halign={CENTER} valign={CENTER} vertical>
		<label label={auth.username} />
		<entry
			visibility={false}
			halign={CENTER}
			valign={CENTER}
			onActivate={() => auth.start_authenticate()}
			setup={self => {
				self.hook(auth, "auth-prompt-hidden", () => {
					auth.supply_secret(self.text)
				})

				self.hook(auth, "success", () => {
					execAsync("Hyprland")
					App.quit()
				})
			}}
		/>
	</box>
)
