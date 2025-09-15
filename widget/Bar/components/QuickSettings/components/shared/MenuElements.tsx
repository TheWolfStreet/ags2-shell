import { Accessor, createState, Node, onCleanup } from "ags"
import { Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { timeout } from "ags/time"

import Pango from "gi://Pango"

import icons from "$lib/icons"
import { Props, toggleClass } from "$lib/utils"

import options from "options"

const { SLIDE_DOWN } = Gtk.RevealerTransitionType
const { VERTICAL } = Gtk.Orientation
const { END } = Pango.EllipsizeMode

export const [opened, set_opened] = createState("")
app.connect("window-toggled", (_, w) => {
	if (w.name == "quicksettings" && !w.visible) {
		timeout(1, () => set_opened(""))
	}
})

type ArrowProps = {
	name: string
	visible: boolean,
	tooltipText: string
}

export function Arrow({ name, visible, activate = false, tooltipText }: Props<Gtk.Button, ArrowProps> & { activate?: false | (() => void) }) {
	let deg = 0
	let open = false

	const [css, set_css] = createState("")
	const getName = typeof name === "function" ? () => name.get() : () => name || ""

	const animate = (step: number) => {
		for (let i = 0; i < 9; i++) {
			timeout(15 * i, () => {
				deg += step
				set_css(`transform: rotate(${deg}deg);`)
			})
		}
	}

	const unsub = opened.subscribe(() => {
		const current = getName()
		if ((opened.get() === current && !open) || (opened.get() !== current && open)) {
			animate(opened.get() === current ? 10 : -10)
			open = !open
		}
	})
	onCleanup(unsub)

	return (
		<button
			class="arrow"
			visible={visible}
			tooltipText={tooltipText ?? ""}
			onClicked={() => {
				const current = getName()
				set_opened(opened.get() === current ? "" : current)
				if (typeof activate === "function") activate()
			}}
		>
			<image iconName={icons.ui.arrow.right} useFallback css={css} />
		</button>
	)
}

type ArrowToggleButtonProps = {
	name: string
	iconName: string
	label: string
}

export function ArrowToggleButton({
	name,
	iconName,
	label,
	activate,
	deactivate,
	activateOnArrow = false,
	connection
}: Props<Gtk.Widget, ArrowToggleButtonProps> & {
	activateOnArrow?: boolean
	connection?: Accessor<boolean>
	activate?: () => void
	deactivate?: () => void
}) {
	const toggleActive = () => {
		if (connection?.get()) {
			deactivate?.()
			if (opened.get() === name) set_opened("")
		} else activate?.()
	}
	const isAccessor = typeof label == "function"
	const tooltipText = isAccessor ? label.as(l => l.length > 13 ? l : "") : (label && label.length > 13 ? label : "")
	return (
		<box class="toggle-button" $={self => {
			toggleClass(self, "active", connection?.get() ?? false)
			connection?.subscribe(() => toggleClass(self, "active", connection.get()))
		}} >
			<button onClicked={toggleActive}
				tooltipText={tooltipText}
			>
				<box class="horizontal" hexpand>
					<image class="icon" iconName={iconName} useFallback />
					<label class="label" ellipsize={END} maxWidthChars={11} label={label} />
				</box>
			</button>
			<Arrow name={name} activate={activateOnArrow ? activate : undefined} visible />
		</box >
	)
}

type MenuProps = Props<Gtk.Widget, {
	name: string
	iconName: string
	title: string
}>
export function Menu({ name, iconName, title, headerChild, children }: MenuProps & {
	headerChild?: Node
	children?: Node | Node[]
}) {
	return (
		<revealer
			transitionType={SLIDE_DOWN}
			transitionDuration={options.transition.duration}
			revealChild={opened((n: string) => {
				return n === name
			})}
			vexpand={false} hexpand={false}
		>
			<box class={`menu ${name}`} orientation={VERTICAL}>
				<box class="title-box">
					<image class="icon" iconName={iconName} useFallback />
					<label class="title" label={title} />
					{headerChild}
				</box>
				<Gtk.Separator />
				<box class="content vertical" orientation={VERTICAL} vexpand hexpand children={children} />
			</box>
		</revealer>
	)
}

type SimpleToggleButtonProps = {
	iconName: string
	label: string
}

export function SimpleToggleButton({
	iconName,
	label,
	toggle,
	connection
}: Props<Gtk.Button, SimpleToggleButtonProps> & {
	connection: Accessor<boolean>
	toggle: () => void
}) {
	const isAccessor = typeof label == "function"
	const tooltipText = isAccessor ? label.as(l => l.length > 13 ? l : "") : (label && label.length > 13 ? label : "")
	return (
		<button
			class="simple-toggle"
			onClicked={toggle}
			tooltipText={tooltipText}
			$={self => { connection.subscribe(() => toggleClass(self, "active", connection.get())) }}
		>
			<box class="horizontal">
				<image iconName={iconName} useFallback />
				<label ellipsize={END} maxWidthChars={11} label={label} />
			</box>
		</button>
	)
}

export function Settings({ callback: callback }: { callback: () => void }) {
	return (
		<button onClicked={callback} hexpand>
			<box class="settings horizontal">
				<image iconName={icons.ui.settings} useFallback />
				<label label={"Settings"} />
			</box>
		</button>
	)
}
