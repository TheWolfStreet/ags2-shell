import { idle } from "astal"
import { Gtk } from "astal/gtk3"

import Row from "./Row"

import icons from "../../../lib/icons"
import { checkDefault } from "../../../lib/utils"

const { START, END } = Gtk.Align

export default function <T>(
	title: string,
	visible: boolean | ReturnType<typeof Row<T>> = true,
	...rows: ReturnType<typeof Row<T>>[]
): void {
	let isVisible = true;

	if (typeof visible === "boolean") {
		isVisible = visible;
	} else {
		rows.unshift(visible);
	}
	return (
		<box className="group" vertical visible={visible}>
			<box>
				<label
					halign={START}
					valign={END}
					className="group-title"
					label={title}
					setup={(w: { visible: boolean }) => idle(() => w.visible = !!title)}
				/>
				{title ? (
					<button
						hexpand
						halign={END}
						className="group-reset"
						sensitive={checkDefault(
							rows
								.filter(row => row.attr != undefined)
								.map(row => row.attr!.opt)
						)}
						onClicked={() => rows.forEach(row => row.attr && row.attr.opt.reset())}
					>
						<icon icon={icons.ui.refresh} useFallback />
					</button>
				) : (
					<box />
				)}
			</box>
			<box vertical>
				{rows}
			</box>
		</box >
	)
}
