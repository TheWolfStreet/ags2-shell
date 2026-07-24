// Shows and changes the do-not-disturb setting.

import { createBinding } from "ags"

import { ToggleButton } from "./shared/MenuElements"

import icons from "$lib/icons"
import { notificationDaemon } from "$service/system"

export namespace DND {
	const dnd = createBinding(notificationDaemon, "dontDisturb")

	export function Toggle() {
		return (
			<ToggleButton
				iconName={dnd.as(v => v ? icons.notifications.silent : icons.notifications.noisy)}
				label={dnd.as(v => v ? "Silent" : "Normal")}
				toggle={() => notificationDaemon.set_dont_disturb(!notificationDaemon.get_dont_disturb())}
				connection={dnd}
			/>
		)
	}

	export function State() {
		return (
			<image
				iconName={icons.notifications.silent}
				visible={dnd}
				useFallback
			/>
		)
	}

}
