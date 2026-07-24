// Shows when recording is active and stops it when clicked.

import { createBinding } from "ags"

import { formatClock } from "$lib/format"
import icons from "$lib/icons"
import { capturer } from "$service/capturer"
import { PanelButton } from "../PanelButton"

export function ScreenRecord() {
	return (
		<PanelButton class="recorder" visible={createBinding(capturer, "recording")} onClicked={() => capturer.stopRecord()}>
			<box class="horizontal">
				<image iconName={icons.recorder.recording} />
				<label label={createBinding(capturer, "timer").as(value => formatClock(value) + " ")} />
			</box>
		</PanelButton>
	)
}
