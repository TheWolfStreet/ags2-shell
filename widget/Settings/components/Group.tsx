import { Gtk } from "ags/gtk4"
import { Accessor, createComputed } from "ags"

import icons from "$lib/icons"
import { Opt } from "$lib/option"

const { START, CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation

export default function Group({
	title,
	visible = true,
	children = [],
	opts = []
}: {
	title: Accessor<string> | string
	visible?: Accessor<boolean> | boolean
	children?: JSX.Element | Array<JSX.Element>
	opts?: Opt<any>[]
}) {
	const anyChanged = opts.length > 0
		? createComputed(() => opts.some(opt => opt() !== opt.getDefault()))
		: false

	const resetGroup = () => opts.forEach(opt => opt.reset())

	return (
		<box class="group" orientation={VERTICAL} visible={visible}>
			<centerbox class="header" valign={CENTER}>
				<label
					class="title"
					$type="start"
					halign={START}
					valign={END}
					label={title}
				/>
				<button
					class="reset"
					$type="end"
					halign={END}
					onClicked={resetGroup}
					sensitive={anyChanged}
				>
					<image iconName={icons.ui.refresh} useFallback />
				</button>
			</centerbox>
			<box orientation={VERTICAL}>
				{children}
			</box>
		</box>
	)
}
