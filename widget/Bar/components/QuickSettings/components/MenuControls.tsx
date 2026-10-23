import { Accessor, createState, FCProps, Node } from "ags"
import { Gtk } from "ags/gtk4"
import { execAsync } from "ags/process"

import Pango from "gi://Pango"

import icons from "$lib/icons"
import { attempt_async, log_error } from "$lib/result"
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

export function Menu({
	name,
	iconName: icon_name,
	title,
	headerChild: header_child,
	children,
}: menu_props & {
	headerChild?: Node
	children?: Node | Node[]
}) {
	return (
		<revealer
			transitionType={SLIDE_DOWN}
			transitionDuration={options.transition.duration}
			revealChild={quick_settings_submenu.opened.as(
				(opened) => opened === (name ?? ""),
			)}
			vexpand={false}
			hexpand={false}
		>
			<box class={`menu ${name ?? ""}`} orientation={VERTICAL}>
				<box class="title-box horizontal">
					<image
						class="icon"
						iconName={icon_name}
						valign={Gtk.Align.CENTER}
						useFallback
					/>
					<label
						class="title"
						label={title}
						valign={Gtk.Align.CENTER}
						yalign={0.5}
					/>
					{header_child}
				</box>
				<Gtk.Separator />
				<box
					class="content vertical"
					orientation={VERTICAL}
					vexpand
					hexpand
					children={children}
				/>
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
	const base = arrow ? "toggle-button" : "simple-toggle"
	const class_name =
		connection?.as((v) => (v ? `${base} active` : base)) ?? base

	return (
		<box class={class_name}>
			<button
				onClicked={on_toggle}
				tooltipText={label}
				sensitive={on_toggle !== undefined}
			>
				<box class="horizontal" hexpand>
					<image class="icon" iconName={icon_name} useFallback />
					<label
						class="label"
						ellipsize={EllipsizeMode.END}
						maxWidthChars={11}
						label={label}
					/>
				</box>
			</button>
			{arrow && <Arrow name={name} visible onArrow={on_arrow} />}
		</box>
	)
}

export function Arrow({
	name,
	visible,
	tooltipText: tooltip_text,
	onArrow: on_arrow,
}: FCProps<Gtk.Button, arrow_props>) {
	const css = quick_settings_submenu.opened.as((opened) =>
		opened === name ? "transform: rotate(90deg);" : "transform: rotate(0deg);",
	)

	return (
		<button
			class="arrow"
			visible={visible}
			tooltipText={tooltip_text ?? ""}
			onClicked={() => {
				if (name) quick_settings_submenu.toggle(name)
				on_arrow?.()
			}}
		>
			<image iconName={icons.ui.arrow.right} useFallback css={css} />
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

export function open_gnome_settings(panel: string) {
	void attempt_async(() =>
		execAsync([
			"env",
			"XDG_CURRENT_DESKTOP=GNOME",
			"gnome-control-center",
			panel,
		]),
	).then((result) =>
		log_error(
			result,
			`quicksettings.settings: Failed to open ${panel} settings`,
		),
	)
}

on_window_toggle("quicksettings", (window) => {
	if (!window.visible) quick_settings_submenu.close()
})

type arrow_props = {
	name?: string
	onArrow?: () => void
	visible?: boolean | Accessor<boolean>
	tooltipText?: string | Accessor<string>
}

type toggle_button_props = {
	name?: string
	iconName?: Accessor<string> | string
	label?: Accessor<string> | string
}

type menu_props = FCProps<
	Gtk.Widget,
	{
		name?: string
		iconName?: Accessor<string> | string
		title?: Accessor<string> | string
	}
>
