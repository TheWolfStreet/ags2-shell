import { Gtk } from "ags/gtk4"
import { Accessor, createComputed, FCProps } from "ags"

import Setter from "./Setter"
import Wallpaper from "./Wallpaper"

import { asusctl } from "$lib/services"
import icons from "$lib/icons"
import { Opt } from "$lib/option"

import options from "options"

const { START, CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation

type PageProps = FCProps<Gtk.StackPage, {
	name: string,
	iconName: string,
	children?: JSX.Element | Array<JSX.Element>
}>

function Page({ name, iconName, children = [] }: PageProps) {
	return (
		<Gtk.StackPage
			name={name}
			iconName={iconName}
			child={
				<Gtk.ScrolledWindow class="page" css="min-height: 300px;">
					<box class="page-content" vexpand orientation={VERTICAL}>
						{children}
					</box>
				</Gtk.ScrolledWindow> as Gtk.ScrolledWindow
			}
		/>
	)
}

type GroupProps = {
	title: Accessor<string> | string
	visible?: Accessor<boolean> | boolean
	children?: JSX.Element | Array<JSX.Element>
	opts?: Opt<any>[]
}

function Group({ title, visible = true, children = [], opts = [] }: GroupProps) {
	const anyChanged = opts.length > 0
		? createComputed(() => opts.some(opt => opt() !== opt.getDefault()))
		: false

	const resetGroup = () => opts.forEach(opt => opt.reset())

	return (
		<box class="group" orientation={VERTICAL} visible={visible}>
			<centerbox class="header" valign={CENTER}>
				<label class="title" $type="start" halign={START} valign={END} label={title} />
				<button class="reset" $type="end" halign={END} onClicked={resetGroup} sensitive={anyChanged}>
					<image iconName={icons.ui.refresh} useFallback />
				</button>
			</centerbox>
			<box orientation={VERTICAL}>
				{children}
			</box>
		</box>
	)
}

export type RowProps = FCProps<
	Gtk.Box,
	{
		opt: Opt<any>
		title?: string
		note?: string
		type?:
		| "number"
		| "color"
		| "float"
		| "object"
		| "string"
		| "enum"
		| "boolean"
		| "img"
		| "font"
		enums?: Array<string | number>
		max?: number
		min?: number
	}
>

function Row({ opt, title, note, type, enums, max, min }: RowProps) {
	const isChanged = opt.as(v => v !== opt.getDefault())

	return (
		<box class="row" tooltipText={note}>
			<box orientation={VERTICAL} valign={CENTER}>
				<label class="row-title" xalign={0} label={title} />
				<label class="id" xalign={0} label={opt.id} />
			</box>

			<box hexpand />

			<box valign={CENTER}>
				<Setter opt={opt} type={type} enums={enums} max={max} min={min} />
				<button class="reset" valign={CENTER} onClicked={() => opt.reset()} sensitive={isChanged}>
					<image iconName={icons.ui.refresh} useFallback />
				</button>
			</box>
		</box>
	)
}

const {
	autotheme: at,
	font,
	theme,
	transition,
	bar: b,
	desktop: de,
	dock: d,
	taskbar: t,
	favorites: f,
	launcher: l,
	overview: ov,
	powermenu: pm,
	notifications: n,
	osd: o,
	hyprland: h,
	asus: s,
} = options

const {
	dark,
	light,
	scheme,
	shadows,
	blur,
	neumorphic,
	opacity,
	padding,
	spacing,
	roundness,
	widget,
	border,
} = theme

const Appearance = () => (
	<Page name="Appearance" iconName={icons.ui.themes}>
		<Group title="Theme" opts={[at, scheme]}>
			<Wallpaper />
			<Row opt={at} title="Auto Generate Color Scheme" />
			<Row opt={scheme} title="Color Scheme" type="enum" enums={["dark", "light"]} />
		</Group>

		<Group title="Dark Colors" opts={[dark.bg, dark.fg, dark.primary.bg, dark.primary.fg, dark.error.bg, dark.error.fg, dark.widget, dark.border]}>
			<Row opt={dark.bg} title="Background" type="color" />
			<Row opt={dark.fg} title="Foreground" type="color" />
			<Row opt={dark.primary.bg} title="Primary" type="color" />
			<Row opt={dark.primary.fg} title="On Primary" type="color" />
			<Row opt={dark.error.bg} title="Error" type="color" />
			<Row opt={dark.error.fg} title="On Error" type="color" />
			<Row opt={dark.widget} title="Widget" type="color" />
			<Row opt={dark.border} title="Border" type="color" />
		</Group>
		<Group title="Light Colors" opts={[light.bg, light.fg, light.primary.bg, light.primary.fg, light.error.bg, light.error.fg, light.widget, light.border]}>
			<Row opt={light.bg} title="Background" type="color" />
			<Row opt={light.fg} title="Foreground" type="color" />
			<Row opt={light.primary.bg} title="Primary" type="color" />
			<Row opt={light.primary.fg} title="On Primary" type="color" />
			<Row opt={light.error.bg} title="Error" type="color" />
			<Row opt={light.error.fg} title="On Error" type="color" />
			<Row opt={light.widget} title="Widget" type="color" />
			<Row opt={light.border} title="Border" type="color" />
		</Group>

		<Group title="Theme" opts={[shadows, blur, neumorphic, opacity, widget.opacity, border.opacity, border.width]}>
			<Row opt={shadows} title="Shadows" />
			<Row opt={blur} title="Blur" type="boolean" />
			<Row opt={neumorphic} title="Neumorphic" type="boolean" />
			<Row opt={opacity} title="Opacity" note="Set to 0 to disable" max={70} />
			<Row opt={widget.opacity} title="Widget Opacity" max={100} />
			<Row opt={border.opacity} title="Border Opacity" max={100} />
			<Row opt={border.width} title="Border Width" max={100} />
		</Group>

		<Group title="UI" opts={[padding, spacing, roundness, transition.duration, font]}>
			<Row opt={padding} title="Padding" max={50} />
			<Row opt={spacing} title="Spacing" max={50} />
			<Row opt={roundness} title="Roundness" max={50} />
			<Row opt={transition.duration} title="Animation Duration" max={2000} />
			<Row opt={font} title="Font" type="font" />
		</Group>
	</Page>
) as Gtk.StackPage

const PanelAndDock = () => (
	<Page name="Panel & Dock" iconName={icons.ui.minus}>
		<Group title="General" opts={[b.transparent, b.position, b.corners]}>
			<Row opt={b.transparent} title="Transparent Bar" note="Works best on minimalist wallpapers" />
			<Row opt={b.position} title="Position" type="enum" enums={["top-center", "bottom-center"]} />
			<Row opt={b.corners} title="Corners" max={100} />
		</Group>

		<Group title="Launcher" opts={[b.launcher.icon]}>
			<Row opt={b.launcher.icon} title="Icon" />
			<Row opt={l.position} title="Position" type="enum" enums={["top-center", "bottom-center"]} />
		</Group>

		<Group title="Workspaces" opts={[b.workspaces.count]}>
			<Row opt={b.workspaces.count} title="Number of Workspaces" max={16} note="Set to 0 to make it dynamic" />
		</Group>

		<Group title="Taskbar" opts={[t.location, b.taskbar.exclusive]}>
			<Row opt={t.location} title="Location" type="enum" enums={["bar", "dock"]} />
			<Row opt={b.taskbar.exclusive} title="Exclusive to workspaces" />
		</Group>

		<Group title="Dock" opts={[d.mode, d.position, d.scale, d.trash]}>
			<Row opt={d.mode} title="Mode" type="enum" enums={["static", "autohide"]} />
			<Row opt={d.position} title="Position" type="enum" enums={["bottom-center", "center-left"]} />
			<Row opt={d.scale} title="Scale" min={50} max={200} />
			<Row opt={d.trash} title="Trash Shortcut" />
		</Group>

		<Group title="Favorites" opts={[f.location]}>
			<Row opt={f.location} title="Show Favorites" type="enum" enums={["disabled", "dock", "launcher", "both"]} />
		</Group>

		<Group title="Date" opts={[b.date.format]}>
			<Row opt={b.date.format} title="Date Format" />
		</Group>

		<Group title="Media" opts={[b.media.preferred]}>
			<Row opt={b.media.preferred} title="Preferred Player" />
		</Group>
	</Page>
) as Gtk.StackPage

const System = () => (
	<Page name="System" iconName={icons.ui.settings}>
		<Group title="Hyprland" opts={[h.inactiveBorder]}>
			<Row opt={h.inactiveBorder} title="Inactive Border Color" type="color" />
		</Group>

		<Group title="Launcher" opts={[l.apps.max]}>
			<Row opt={l.apps.max} title="Max Items" max={9} />
		</Group>

		<Group title="Overview" opts={[ov.scale, ov.workspaces]}>
			<Row opt={ov.scale} title="Scale" min={50} max={200} />
			<Row opt={ov.workspaces} title="Workspaces" max={16} note="Set to 0 to make it dynamic" />
		</Group>

		<Group title="Desktop" opts={[de.enabled, de.iconSize]}>
			<Row opt={de.enabled} title="Desktop Icons" />
			<Row opt={de.iconSize} title="Icon Size" type="enum" enums={["small", "medium", "large", "extralarge"]} />
		</Group>

		<Group title="Notifications" opts={[n.position]}>
			<Row opt={n.position} title="Position" type="enum" enums={["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"]} />
		</Group>

		<Group title="OSD" opts={[o.position]}>
			<Row opt={o.position} title="Position" type="enum" enums={["center", "bottom-center"]} />
		</Group>

		<Group title="Powermenu" opts={[pm.layout, pm.labels]}>
			<Row opt={pm.layout} title="Layout" type="enum" enums={["box", "line"]} />
			<Row opt={pm.labels} title="Show Labels" />
		</Group>

		<Group title="ASUS" visible={asusctl.available} opts={[s.resolution, s.ac_hz, s.bat_hz]}>
			<Row opt={s.resolution} title="Screen Resolution" type="string" note="Format: WIDTHxHEIGHT (e.g., 1920x1200)" />
			<Row opt={s.ac_hz} title="Screen Refresh Rate (AC)" type="enum" enums={[144, 240, 60]} />
			<Row opt={s.bat_hz} title="Screen Refresh Rate (Battery)" type="enum" enums={[60, 144, 240]} />
		</Group>
	</Page>
) as Gtk.StackPage

export const createLayout = (): Gtk.StackPage[] => [
	Appearance(),
	PanelAndDock(),
	System(),
]
