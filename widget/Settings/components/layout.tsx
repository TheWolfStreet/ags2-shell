import Row from "./Row"
import Group from "./Group"
import Page, { PageWidget } from "./Page"
import Wallpaper from "./Wallpaper"

import { asusctl } from "$lib/services"
import icons from "$lib/icons"

import options from "options"

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
	blur,
	blurOnLight,
	scheme,
	padding,
	spacing,
	radius,
	shadows,
	widget,
	border,
} = theme

const theme_page =
	<Page name="Theme" icon={icons.ui.themes} >
		<Group title="Theme">
			<Wallpaper />
			<Row opt={at} title="Auto Generate Color Scheme" />
			<Row opt={scheme} title="Color Scheme" type="enum" enums={["dark", "light"]} />
		</Group>

		<Group title="Dark Colors">
			<Row opt={dark.bg} title="Background" type="color" />
			<Row opt={dark.fg} title="Foreground" type="color" />
			<Row opt={dark.primary.bg} title="Primary" type="color" />
			<Row opt={dark.primary.fg} title="On Primary" type="color" />
			<Row opt={dark.error.bg} title="Error" type="color" />
			<Row opt={dark.error.fg} title="On Error" type="color" />
			<Row opt={dark.widget} title="Widget" type="color" />
			<Row opt={dark.border} title="Border" type="color" />
		</Group>
		<Group title="Light Colors">
			<Row opt={light.bg} title="Background" type="color" />
			<Row opt={light.fg} title="Foreground" type="color" />
			<Row opt={light.primary.bg} title="Primary" type="color" />
			<Row opt={light.primary.fg} title="On Primary" type="color" />
			<Row opt={light.error.bg} title="Error" type="color" />
			<Row opt={light.error.fg} title="On Error" type="color" />
			<Row opt={light.widget} title="Widget" type="color" />
			<Row opt={light.border} title="Border" type="color" />
		</Group>

		<Group title="Theme">
			<Row opt={shadows} title="Shadows" />
			<Row opt={blurOnLight} title="Blur on light theme" type="boolean" />
			<Row opt={blur} title="Blur" note="Set to 0 to disable" max={70} />
			<Row opt={widget.opacity} title="Widget Opacity" max={100} />
			<Row opt={border.opacity} title="Border Opacity" max={100} />
			<Row opt={border.width} title="Border Width" max={100} />
		</Group>

		<Group title="UI">
			<Row opt={padding} title="Padding" />
			<Row opt={spacing} title="Spacing" />
			<Row opt={radius} title="Roundness" />
			<Row opt={transition.duration} title="Animation Duration" />
			<Row opt={font.size} title="Font Size" />
			<Row opt={font.name} title="Font Name" type="font" />
		</Group>
	</Page >

const bar_page =
	<Page name="Bar" icon={icons.ui.minus}>
		<Group title="General">
			<Row opt={b.transparent} title="Transparent Bar" note="Works best on minimalist wallpapers" />
			<Row opt={b.position} title="Position" type="enum" enums={["top", "bottom"]} />
			<Row opt={b.corners} title="Corners" />
		</Group>

		<Group title="Launcher">
			<Row opt={b.launcher.icon} title="Icon" />
		</Group>

		<Group title="Workspaces">
			<Row opt={b.workspaces.count} title="Number of Workspaces" note="Set to 0 to make it dynamic" />
		</Group>

		<Group title="Taskbar">
			<Row opt={b.taskbar.exclusive} title="Exclusive to workspaces" />
		</Group>

		<Group title="Date">
			<Row opt={b.date.format} title="Date Format" />
		</Group>

		<Group title="Media">
			<Row opt={b.media.preferred} title="Preferred Player" />
		</Group>
	</Page>

const general_page =
	<Page name="General" icon={icons.ui.settings} >
		<Group title="Hyprland">
			<Row opt={h.inactiveBorder} title="Inactive Border Color" type="color" />
		</Group>

		<Group title="Launcher">
			<Row opt={l.apps.max} title="Max Items" max={9} />
		</Group>

		<Group title="Overview">
			<Row opt={ov.scale} title="Scale" max={100} />
			<Row opt={ov.workspaces} title="Workspaces" max={11} note="Set to 0 to make it dynamic" />
		</Group>

		<Group title="Powermenu">
			<Row opt={pm.layout} title="Layout" type="enum" enums={["box", "line"]} />
			<Row opt={pm.labels} title="Show Labels" />
		</Group>

		<Group title="ASUS" visible={asusctl.available}>
			<Row opt={s.ac_hz} title="Screen Refresh Rate (AC)" min={60} note="60HZ is the minimum to avoid breakage" />
			<Row opt={s.bat_hz} title="Screen Refresh Rate (Battery)" min={60} note="60HZ is the minimum to avoid breakage" />
		</Group>
	</Page >

export const layout = [theme_page, bar_page, general_page] as Array<PageWidget>

