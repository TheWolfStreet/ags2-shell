import { Accessor, createComputed, createState, FCProps, Node } from "ags"
import { Gtk } from "ags/gtk4"

import Pango from "gi://Pango"

import icons from "$lib/icons"
import { is_accessor, read_value } from "$lib/ui"
import { on_window_toggle } from "$lib/windowing"

import options from "$shell/options"

const { SLIDE_DOWN } = Gtk.RevealerTransitionType
const { VERTICAL } = Gtk.Orientation
const { EllipsizeMode } = Pango

const [opened_menu_name, set_opened_menu_name] = createState("")

export const quick_settings_submenu = {
	opened: opened_menu_name,
	close: () => {
		set_opened_menu_name("")
	},
	toggle: (name: string) => {
		set_opened_menu_name(opened_menu_name.peek() === name ? "" : name)
	},
}

export function Menu({ name, iconName: icon_name, title, headerChild: header_child, children }: menu_props & {
	headerChild?: Node
	children?: Node | Node[]
}) {
	const menu_name = () => read_value(name) ?? ""
	const class_name = is_accessor<string>(name) ? name.as(value => `menu ${value}`) : `menu ${name ?? ""}`

	return (
		<revealer
			transitionType={SLIDE_DOWN}
			transitionDuration={options.transition.duration}
			revealChild={createComputed(() => quick_settings_submenu.opened() === menu_name())}
			vexpand={false} hexpand={false}
		>
			<box
				class={class_name}
				orientation={VERTICAL}
			>
				<box class="title-box horizontal">
					<image class="icon" iconName={icon_name} valign={Gtk.Align.CENTER} useFallback />
					<label class="title" label={title} valign={Gtk.Align.CENTER} yalign={0.5} />
					{header_child}
				</box>
				<Gtk.Separator />
				<box class="content vertical" orientation={VERTICAL} vexpand hexpand children={children} />
			</box>
		</revealer>
	)
}

export function ToggleButton({
	name,
	iconName: icon_name,
	label,
	connection,
	onToggle: on_toggle,
	onArrow: on_arrow,
	arrow = false,
}: FCProps<Gtk.Widget, toggle_button_props> & {
	connection?: Accessor<boolean>
	onToggle?: () => void
	onArrow?: () => void
	arrow?: boolean
}) {
	const arrow_rotation = arrow ? use_arrow_rotation(name) : null

	const base = arrow ? "toggle-button" : "simple-toggle"
	const class_name = connection?.as(v => v ? `${base} active` : base) ?? base

	return (
		<box class={class_name}>
			<button onClicked={on_toggle} tooltipText={label} sensitive={on_toggle !== undefined}>
				<box class="horizontal" hexpand>
					<image class="icon" iconName={icon_name} useFallback />
					<label class="label" ellipsize={EllipsizeMode.END} maxWidthChars={11} label={label} />
				</box>
			</button>
			{arrow && arrow_rotation && (
				<button class="arrow" visible onClicked={() => {
					arrow_rotation.toggle_menu()
					on_arrow?.()
				}}>
					<image iconName={icons.ui.arrow.right} useFallback css={arrow_rotation.css} />
				</button>
			)}
		</box>
	)
}

export function Arrow(
	{
		name,
		visible,
		tooltipText: tooltip_text
	}: FCProps<Gtk.Button, arrow_props>
) {
	const arrow_rotation = use_arrow_rotation(name)

	return (
		<button
			class="arrow"
			visible={visible}
			tooltipText={tooltip_text ?? ""}
			onClicked={() => {
				arrow_rotation.toggle_menu()
			}}
		>
			<image iconName={icons.ui.arrow.right} useFallback css={arrow_rotation.css} />
		</button>
	)
}

export function SettingsButton({ callback }: { callback: () => void }) {
	return (
		<button onClicked={callback} hexpand>
			<box class="settings horizontal">
				<image iconName={icons.ui.settings} useFallback />
				<label label={"Settings"} />
			</box>
		</button>
	)
}

on_window_toggle("quicksettings", window => {
	if (!window.visible) quick_settings_submenu.close()
})

function use_arrow_rotation(name?: Accessor<string> | string) {
	const menu_name = () => read_value(name)
	const css = createComputed(() => quick_settings_submenu.opened() === menu_name()
		? "transform: rotate(90deg);" : "transform: rotate(0deg);")

	return {
		css,
		toggle_menu: () => {
			const name = menu_name()
			if (name) {
				quick_settings_submenu.toggle(name)
			}
		},
	}
}

type arrow_props = {
	name?: string | Accessor<string>
	visible?: boolean | Accessor<boolean>
	tooltipText?: string | Accessor<string>
}

type toggle_button_props = {
	name?: Accessor<string> | string
	iconName?: Accessor<string> | string
	label?: Accessor<string> | string
}

type menu_props = FCProps<Gtk.Widget, {
	name?: Accessor<string> | string
	iconName?: Accessor<string> | string
	title?: Accessor<string> | string
}>
