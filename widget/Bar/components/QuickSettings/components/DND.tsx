import { createBinding } from "gnim"

import { SimpleToggleButton } from "./shared/MenuElements"

import icons from "$lib/icons"
import { notifd } from "$lib/services"

export namespace DND {
	const dnd = createBinding(notifd, "dontDisturb")

	export function Toggle() {
		return (
			<SimpleToggleButton
				iconName={dnd.as(v => v ? icons.notifications.silent : icons.notifications.noisy)}
				label={dnd.as(v => v ? "Silent" : "Normal")}
				toggle={() => notifd.set_dont_disturb(!notifd.get_dont_disturb())}
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
