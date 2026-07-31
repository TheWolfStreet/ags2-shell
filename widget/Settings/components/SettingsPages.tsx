// Shows three Settings tabs and finds each group's changed rows for automatic reset buttons.

import { Gtk } from "ags/gtk4"
import { Accessor, createBinding, createComputed, FCProps } from "ags"

import Setter, { type CommonOption, type EditorType } from "./Setter"
import WallpaperChooser from "./WallpaperChooser"

import { asusctl } from "$service/asusctl"
import icons from "$lib/icons"

import options, { optionValues } from "options"

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
				<Gtk.ScrolledWindow
					class="page"
					css={options.scale.as(scale => `min-height: ${Math.round(300 * scale / 100)}px;`)}
				>
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
}

const optionByRow = new WeakMap<object, CommonOption>()

function collectRowOptions(children: JSX.Element | JSX.Element[]) {
	const options = new Set<CommonOption>()
	const visit = (child: unknown) => {
		if (!child || typeof child !== "object") return
		const option = optionByRow.get(child)
		if (option) options.add(option)
		if (!(child instanceof Gtk.Widget)) return
		for (let nested = child.get_first_child(); nested; nested = nested.get_next_sibling())
			visit(nested)
	}
	for (const child of Array.isArray(children) ? children : [children]) visit(child)
	return [...options]
}

function Group({ title, visible = true, children = [] }: GroupProps) {
	const groupOptions = collectRowOptions(children)
	const anyChanged = groupOptions.length > 0
		? createComputed(() => groupOptions.some(opt => opt() !== opt.getDefault()))
		: false

	const resetGroup = () => groupOptions.forEach(opt => opt.reset())

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
		opt: CommonOption
		title?: string
		note?: string
		type?: EditorType
		enums?: readonly (string | number)[]
		max?: number
		min?: number
	}
>

function Row({ opt, title, note, type, enums, max, min }: RowProps) {
	const isChanged = createComputed(() => opt() !== opt.getDefault())

	const row = (
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
	) as Gtk.Box
	optionByRow.set(row, opt)
	return row
}

const {
	autotheme,
	scale: uiScale,
	font,
	theme,
	transition,
	bar,
	desktop,
	dock,
	taskbar,
	favorites,
	launcher,
	overview,
	powermenu,
	notifications,
	osd,
	hyprland,
	asus,
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
		<Group title="Theme">
				<WallpaperChooser />
			<Row opt={scheme} title="Scheme" type="enum" enums={optionValues.themeScheme} />
			<Row opt={autotheme} title="Generate from Wallpaper" />
		</Group>

		<Group title="Interface">
			<Row opt={uiScale} title="Scale" min={50} max={200} note="Scales the whole shell — helps on small or low-res displays" />
			<Row opt={font} title="Font" type="font" />
			<Row opt={roundness} title="Roundness" max={50} />
			<Row opt={spacing} title="Spacing" max={50} />
			<Row opt={padding} title="Padding" max={50} />
			<Row opt={transition.duration} title="Animation Duration" max={2000} />
		</Group>

		<Group title="Effects">
			<Row opt={blur} title="Enable Blur" type="boolean" />
			<Row opt={shadows} title="Show Shadows" />
			<Row opt={neumorphic} title="Use Neumorphic Style" type="boolean" />
			<Row opt={opacity} title="Opacity" note="Set to 0 to disable" max={70} />
			<Row opt={widget.opacity} title="Widget Opacity" max={100} />
			<Row opt={border.width} title="Border Width" max={100} />
			<Row opt={border.opacity} title="Border Opacity" max={100} />
			<Row opt={hyprland.inactiveBorder} title="Inactive Border" type="color" />
		</Group>

		<Group
			title="Dark Colors"
			visible={scheme.as(value => value === "dark")}
		>
			<Row opt={dark.primary.bg} title="Primary" type="color" />
			<Row opt={dark.bg} title="Background" type="color" />
			<Row opt={dark.fg} title="Foreground" type="color" />
			<Row opt={dark.primary.fg} title="On Primary" type="color" />
			<Row opt={dark.widget} title="Widget" type="color" />
			<Row opt={dark.border} title="Border" type="color" />
			<Row opt={dark.error.bg} title="Error" type="color" />
		</Group>

		<Group
			title="Light Colors"
			visible={scheme.as(value => value === "light")}
		>
			<Row opt={light.primary.bg} title="Primary" type="color" />
			<Row opt={light.bg} title="Background" type="color" />
			<Row opt={light.fg} title="Foreground" type="color" />
			<Row opt={light.primary.fg} title="On Primary" type="color" />
			<Row opt={light.widget} title="Widget" type="color" />
			<Row opt={light.border} title="Border" type="color" />
			<Row opt={light.error.bg} title="Error" type="color" />
		</Group>
	</Page>
) as Gtk.StackPage

const Shell = () => (
	<Page name="Shell" iconName={icons.ui.toolbars}>
		<Group title="Bar">
			<Row opt={bar.position} title="Position" type="enum" enums={optionValues.barPosition} />
			<Row opt={bar.transparent} title="Use Transparency" note="Works best on minimalist wallpapers" />
			<Row opt={bar.date.format} title="Date Format" />
			<Row opt={bar.corners} title="Corners" max={100} />
			<Row opt={bar.media.preferred} title="Media Player" />
		</Group>

		<Group title="Taskbar">
			<Row opt={taskbar.location} title="Location" type="enum" enums={optionValues.taskbarLocation} />
			<Row opt={bar.taskbar.exclusive} title="Only Current Workspace" />
		</Group>

		<Group title="Dock">
			<Row opt={dock.mode} title="Mode" type="enum" enums={optionValues.dockMode} />
			<Row opt={dock.position} title="Position" type="enum" enums={optionValues.dockPosition} />
			<Row opt={dock.scale} title="Scale" min={50} max={200} />
			<Row opt={dock.trash} title="Show Trash" />
		</Group>

		<Group title="Launcher">
			<Row opt={launcher.position} title="Position" type="enum" enums={optionValues.launcherPosition} />
			<Row opt={launcher.scale} title="Scale" min={50} max={200} />
			<Row opt={favorites.location} title="Favorites" type="enum" enums={optionValues.favoritesLocation} />
			<Row opt={launcher.apps.max} title="Max Items" max={9} />
			<Row opt={bar.launcher.icon} title="Icon" />
		</Group>

		<Group title="Workspaces">
			<Row opt={bar.workspaces.count} title="Count" max={16} note="Set to 0 to make it dynamic" />
		</Group>

		<Group title="Overview">
			<Row opt={overview.workspaces} title="Workspaces" max={16} note="Set to 0 to make it dynamic" />
			<Row opt={overview.scale} title="Scale" min={50} max={200} />
		</Group>
	</Page>
) as Gtk.StackPage

const System = () => (
	<Page name="System" iconName={icons.ui.settings}>
		<Group title="Notifications">
			<Row opt={notifications.position} title="Position" type="enum" enums={optionValues.popupPosition} />
		</Group>

		<Group title="Desktop">
			<Row opt={desktop.enabled} title="Show Icons" />
			<Row opt={desktop.iconSize} title="Icon Size" type="enum" enums={optionValues.desktopIconSize} />
		</Group>

		<Group title="Power Menu">
			<Row opt={powermenu.layout} title="Layout" type="enum" enums={optionValues.powerMenuLayout} />
			<Row opt={powermenu.labels} title="Show Labels" />
		</Group>

		<Group title="OSD">
			<Row opt={osd.position} title="Position" type="enum" enums={optionValues.osdPosition} />
		</Group>

		<Group title="ASUS" visible={createBinding(asusctl, "available")}>
			<Row opt={asus.ac_hz} title="Refresh Rate (AC)" type="enum" enums={asusctl.refreshRates} />
			<Row opt={asus.bat_hz} title="Refresh Rate (Battery)" type="enum" enums={asusctl.refreshRates} />
		</Group>
	</Page>
) as Gtk.StackPage

export const createSettingsPages = (): Gtk.StackPage[] => [
	Appearance(),
	Shell(),
	System(),
]
