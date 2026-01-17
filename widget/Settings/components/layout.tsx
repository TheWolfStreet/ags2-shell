import Group from "./Group"
import { Row } from "./Row"
import { Page } from "./Page"
import Wallpaper from "./Wallpaper"

import { asusctl } from "$lib/services"
import icons from "$lib/icons"

import options from "options"
import { Gtk } from "ags/gtk4"

const {
	autotheme: at,
	font,
	theme,
	transition,
	bar: b,
	launcher: l,
	overview: ov,
	powermenu: pm,
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
	radius,
	widget,
	border,
} = theme

const Theme = () => (
	<Page name="Theme" iconName={icons.ui.themes}>
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

		<Group title="UI" opts={[padding, spacing, radius, transition.duration, font]}>
			<Row opt={padding} title="Padding" />
			<Row opt={spacing} title="Spacing" />
			<Row opt={radius} title="Roundness" />
			<Row opt={transition.duration} title="Animation Duration" />
			<Row opt={font} title="Font" type="font" />
		</Group>
	</Page>
) as Gtk.StackPage

const Bar = () => (
	<Page name="Bar" iconName={icons.ui.minus}>
		<Group title="General" opts={[b.transparent, b.position, b.corners]}>
			<Row opt={b.transparent} title="Transparent Bar" note="Works best on minimalist wallpapers" />
			<Row opt={b.position} title="Position" type="enum" enums={["top", "bottom"]} />
			<Row opt={b.corners} title="Corners" />
		</Group>

		<Group title="Launcher" opts={[b.launcher.icon]}>
			<Row opt={b.launcher.icon} title="Icon" />
		</Group>

		<Group title="Workspaces" opts={[b.workspaces.count]}>
			<Row opt={b.workspaces.count} title="Number of Workspaces" note="Set to 0 to make it dynamic" />
		</Group>

		<Group title="Taskbar" opts={[b.taskbar.exclusive]}>
			<Row opt={b.taskbar.exclusive} title="Exclusive to workspaces" />
		</Group>

		<Group title="Date" opts={[b.date.format]}>
			<Row opt={b.date.format} title="Date Format" />
		</Group>

		<Group title="Media" opts={[b.media.preferred]}>
			<Row opt={b.media.preferred} title="Preferred Player" />
		</Group>
	</Page>
) as Gtk.StackPage

const General = () => (
	<Page name="General" iconName={icons.ui.settings}>
		<Group title="Hyprland" opts={[h.inactiveBorder]}>
			<Row opt={h.inactiveBorder} title="Inactive Border Color" type="color" />
		</Group>

		<Group title="Launcher" opts={[l.apps.max]}>
			<Row opt={l.apps.max} title="Max Items" max={9} />
		</Group>

		<Group title="Overview" opts={[ov.scale, ov.workspaces]}>
			<Row opt={ov.scale} title="Scale" max={100} />
			<Row opt={ov.workspaces} title="Workspaces" max={11} note="Set to 0 to make it dynamic" />
		</Group>

		<Group title="Powermenu" opts={[pm.layout, pm.labels]}>
			<Row opt={pm.layout} title="Layout" type="enum" enums={["box", "line"]} />
			<Row opt={pm.labels} title="Show Labels" />
		</Group>

		<Group title="ASUS" visible={asusctl.available} opts={[s.resolution, s.ac_hz, s.bat_hz]}>
			<Row opt={s.resolution} title="Screen Resolution" type="string" note="Format: WIDTHxHEIGHT (e.g., 1920x1200)" />
			<Row opt={s.ac_hz} title="Screen Refresh Rate (AC)" min={60} note="60HZ is the minimum to avoid breakage" />
			<Row opt={s.bat_hz} title="Screen Refresh Rate (Battery)" min={60} note="60HZ is the minimum to avoid breakage" />
		</Group>
	</Page>
) as Gtk.StackPage

export const createLayout = (): Gtk.StackPage[] => [
	Theme(),
	Bar(),
	General()
]
