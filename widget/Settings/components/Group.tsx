import { Gtk } from "ags/gtk4"
import { Accessor, createComputed, Node } from "ags"

import { Row } from "./Row"

import icons from "$lib/icons"
import { Opt } from "$lib/option"

const { START, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation

export default function Group({ title, visible = true, children = [] }: { title: Accessor<string> | string, visible?: boolean | Accessor<boolean>, children?: Row | Row[] }) {
	const nodes = Array.isArray(children) ? children : [children]
	const opts: Opt<any>[] = []

	for (const child of nodes) {
		const opt = child?.attr?.opt
		if (opt) opts.push(opt)
	}

	let anyChanged = createComputed(opts, () => {
		for (const opt of opts) {
			if (opt.get() !== opt.getDefault()) return true
		}
		return false
	})

	return (
		<box class="group" orientation={VERTICAL} visible={visible}>
			<centerbox>
				<button
					class="group-reset"
					$type="end"
					halign={END}
					onClicked={() => {
						if (children) {
							const nodes = Array.isArray(children) ? children : [children]
							nodes.forEach(row => row?.attr?.opt?.reset())
						}
					}}
					sensitive={anyChanged}
				>
					<image iconName={icons.ui.refresh} useFallback />
				</button>
				<label
					class="group-title"
					$type="start"
					halign={START}
					valign={END}
					label={title}
				/>
			</centerbox>
			<box orientation={VERTICAL}>
				{children}
			</box>
		</box>
	)
}
