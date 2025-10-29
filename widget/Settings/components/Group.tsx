import { Gtk } from "ags/gtk4"
import { Accessor, createComputed, Node } from "ags"

import icons from "$lib/icons"
import { Opt } from "$lib/option"

const { START, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation

const getOptsFromChildren = (children: JSX.Element | Array<JSX.Element>): Opt<any>[] => {
	const nodes = Array.isArray(children) ? children : [children]
	return nodes
		.filter(child => child && typeof child === 'object' && 'props' in child)
		.map(child => (child.props as any)?.opt)
		.filter(opt => opt instanceof Opt)
}

export default function Group({
	title,
	visible = true,
	children = []
}: {
	title: Accessor<string> | string
	visible?: Accessor<boolean> | boolean
	children?: JSX.Element | Array<JSX.Element>
}) {
	const opts = getOptsFromChildren(children)
	const anyChanged = createComputed(opts, () => opts.some(opt => opt.get() !== opt.getDefault()))
	const resetGroup = () => opts.forEach(opt => opt.reset())

	return (
		<box class="group" orientation={VERTICAL} visible={visible}>
			<centerbox>
				<label
					class="group-title"
					$type="start"
					halign={START}
					valign={END}
					label={title}
				/>
				<button
					class="group-reset"
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
