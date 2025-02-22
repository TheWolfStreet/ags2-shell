import { Binding, timeout, Variable } from "astal"
import { App, Gtk, Widget } from "astal/gtk3"

import { Separator } from "../../../../GtkWidgets"

import { initHook } from "../../../../../lib/utils"
import icons from "../../../../../lib/icons"

const { SLIDE_DOWN } = Gtk.RevealerTransitionType

export const opened = Variable("")
App.connect("window-toggled", (_, w) => {
	if (w.name == "quicksettings" && !w.visible) {
		timeout(1, () => opened.set(""))
	}
})

type ArrowProps = {
	name: string
	activate?: false | (() => void)
	tooltipText?: Binding<string> | string
}

export function Arrow({ name, activate = false, tooltipText }: ArrowProps) {
	let deg = 0
	let open = false
	const css = Variable("")

	return <button
		className="arrow"
		tooltipText={tooltipText ?? ""}
		onClicked={() => {
			opened.set(opened.get() === name ? "" : name)
			if (typeof activate === "function") {
				activate()
			}
		}}
	>
		<icon icon={icons.ui.arrow.right} useFallback css={css()}
			setup={self => self.hook(opened, () => {
				const v = opened.get()
				if (
					(v === name && !open) ||
					(v !== name && open)
				) {
					const step = opened.get() === name ? 10 : -10
					open = !open
					for (let i = 0; i < 9; ++i) {
						timeout(15 * i, () => {
							deg += step
							css.set(`-gtk-icon-transform: rotate(${deg}deg);`)
						})
					}
				}
			})}
		/>
	</button>
}

type ArrowToggleButtonProps = {
	name: string
	icon: Widget.IconProps["icon"]
	label: Widget.LabelProps["label"]
	activate?: () => void
	deactivate?: () => void
	activateOnArrow?: boolean
	connection: Binding<boolean>
}

export const ArrowToggleButton = ({
	name,
	icon,
	label,
	activate,
	deactivate,
	activateOnArrow = true,
	connection
}: ArrowToggleButtonProps) =>
	<box
		className="toggle-button"
		setup={self => { initHook(self, connection, () => self.toggleClassName("active", connection.get())) }}
	>
		<button
			onClicked={() => {
				if (connection.get()) {
					deactivate?.()
					if (opened.get() === name) {
						opened.set("")
					}
				} else {
					activate?.()
				}
			}}
		>
			<box className="horizontal" hexpand>
				<icon className="icon" icon={icon} useFallback />
				<label className="label" maxWidthChars={12} truncate label={label} />
			</box>
		</button>
		<Arrow
			name={name}
			activate={activateOnArrow && activate}
		/>
	</box>

type MenuProps = Widget.BoxProps & {
	name: string
	icon: Widget.IconProps["icon"]
	title: Widget.LabelProps["label"]
	headerChild?: JSX.Element
	child?: JSX.Element
}

export const Menu = ({ name, icon, title, headerChild, child }: MenuProps) =>
	<revealer
		transitionType={SLIDE_DOWN}
		revealChild={opened((n: string) => {
			return n === name
		})}
		vexpand={false} hexpand={false}
	>
		<box className={`menu ${name}`} vertical>
			<box className="title-box">
				<icon className="icon" icon={icon} useFallback />
				<label className="title" truncate label={title} />
				{headerChild}
			</box>
			<Separator />
			<box className="content vertical" vertical vexpand hexpand child={child} />
		</box>
	</revealer>

type SimpleToggleButtonProps = {
	icon: string | Binding<string>
	label: string | Binding<string>
	toggle: () => void
	connection: Binding<boolean>
}

export const SimpleToggleButton = ({
	icon,
	label,
	toggle,
	connection
}: SimpleToggleButtonProps) =>
	<button
		onClicked={toggle}
		className="simple-toggle"
		setup={self => { initHook(self, connection, () => self.toggleClassName("active", connection.get())) }}
	>
		<box className="horizontal">
			<icon icon={icon} useFallback />
			<label maxWidthChars={10} truncate label={label} />
		</box>
	</button>
