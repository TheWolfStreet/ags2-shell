import { Widget } from "astal/gtk3"

import { onWindowToggle } from "../../../lib/utils"

type PanelButtonProps = Widget.ButtonProps & {
	flat?: boolean
}

export default ({
	flat,
	setup,
	...props
}: PanelButtonProps) =>
	<button {...props}
		setup={self => {
			self.toggleClassName("panel-button")
			self.toggleClassName(self.name)

			if (self.name) {
				onWindowToggle(self, self.name, w => self.toggleClassName("active", w.visible))
			}
			setup && setup(self)
		}}
	/>
