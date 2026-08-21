// Shows three tabs and finds each group's changed rows for automatic reset buttons.

import { Gdk, Gtk } from "ags/gtk4"
import { Accessor, createBinding, createComputed } from "ags"

import Gio from "gi://Gio"

import Setter, { type EditorType } from "./Setter"

import { Placeholder } from "widget/shared/Placeholder"

import { asusctl } from "$service/asusctl"
import {
	clearWallpaper,
	setWallpaper,
	wallpaperPath,
	wallpaperRevision,
} from "$lib/wallpaper"
import { fileExists } from "$lib/files"
import icons from "$lib/icons"
import { attempt } from "$lib/result"
import { getFileSize, textureFromFile } from "$lib/textures"
import { isDialogDismissed } from "$lib/ui"

import options, { Opt, optionValues } from "$shell/options"

const { START, CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { COVER } = Gtk.ContentFit
const { CROSSFADE } = Gtk.RevealerTransitionType

type PageProps = {
	name: string
	iconName: string
	children?: JSX.Element | Array<JSX.Element>
}

function Page({ name, iconName, children = [] }: PageProps) {
	return (
		<Gtk.StackPage
			name={name}
			iconName={iconName}
			child={
				(
					<Gtk.ScrolledWindow
						class="page"
						css={options.scale.as(
							(scale) => `min-height: ${Math.round((300 * scale) / 100)}px;`,
						)}
					>
						<box class="page-content" vexpand orientation={VERTICAL}>
							{children}
						</box>
					</Gtk.ScrolledWindow>
				) as Gtk.ScrolledWindow
			}
		/>
	)
}

function WallpaperChooser() {
	const wall = wallpaperRevision.as(() => wallpaperPath)
	const isSet = wall.as((path) => !!path && (getFileSize(path) ?? 0) > 0)
	let dialog: Gtk.FileDialog
	let dialogOpen = false

	function openDialog() {
		if (dialogOpen) return
		dialogOpen = true

		const opened = attempt(() => {
			dialog ??= new Gtk.FileDialog({ title: "Set wallpaper", modal: true })
			if (fileExists(wallpaperPath))
				dialog.set_initial_file(Gio.File.new_for_path(wallpaperPath))

			dialog.open(null, null, (_, result) => {
				dialogOpen = false
				if (!result) return

				const outcome = attempt(
					() => dialog.open_finish(result)?.get_path() ?? null,
				)
				if (outcome.ok) {
					if (outcome.value) void setWallpaper(outcome.value)
					return
				}

				if (!isDialogDismissed(outcome.err))
					console.error(
						"wallpaper.dialog: Failed to choose wallpaper",
						outcome.err,
					)
			})
		})

		if (!opened.ok) {
			dialogOpen = false
			console.error(
				"wallpaper.dialog: Failed to open wallpaper chooser",
				opened.err,
			)
		}
	}

	return (
		<box class="row">
			<overlay
				cursor={Gdk.Cursor.new_from_name("pointer", null)}
				tooltipText={isSet.as((set) => (set ? "Middle-click to clear" : ""))}
			>
				<Gtk.GestureClick button={Gdk.BUTTON_PRIMARY} onPressed={openDialog} />
				<Gtk.GestureClick
					button={Gdk.BUTTON_MIDDLE}
					onPressed={clearWallpaper}
				/>
				<revealer
					transitionDuration={options.transition.duration.as(
						(value) => value * 4,
					)}
					revealChild={isSet.as((set) => !set)}
					transitionType={CROSSFADE}
					$type="overlay"
				>
					<Placeholder
						iconName={icons.missing}
						label="Click here to set wallpaper"
					/>
				</revealer>
				<Gtk.Picture
					class="preview"
					hexpand
					vexpand
					canShrink
					contentFit={COVER}
					paintable={wall.as((path) => textureFromFile(path) as Gdk.Paintable)}
				/>
			</overlay>
		</box>
	)
}

type GroupProps = {
	title: Accessor<string> | string
	visible?: Accessor<boolean> | boolean
	children?: JSX.Element | Array<JSX.Element>
}

const optionByRow = new WeakMap<object, Opt<any>>()

function collectRowOptions(children: JSX.Element | JSX.Element[]) {
	return (Array.isArray(children) ? children : [children])
		.map((child) =>
			child && typeof child === "object" ? optionByRow.get(child) : undefined,
		)
		.filter((opt): opt is Opt<any> => opt !== undefined)
}

function Group({ title, visible = true, children = [] }: GroupProps) {
	const groupOptions = collectRowOptions(children)
	const anyChanged =
		groupOptions.length > 0
			? createComputed(() =>
					groupOptions.some((opt) => opt() !== opt.getDefault()),
				)
			: false

	const resetGroup = () => groupOptions.forEach((opt) => opt.reset())

	return (
		<box class="group" orientation={VERTICAL} visible={visible}>
			<centerbox class="header" valign={CENTER}>
				<label
					class="title"
					$type="start"
					halign={START}
					valign={END}
					label={title}
				/>
				<button
					class="reset"
					$type="end"
					halign={END}
					onClicked={resetGroup}
					sensitive={anyChanged}
				>
					<image iconName={icons.ui.refresh} useFallback />
				</button>
			</centerbox>
			<box orientation={VERTICAL}>{children}</box>
		</box>
	)
}

type RowProps = {
	opt: Opt<any>
	title: string
	note?: string
	type?: EditorType
	enums?: readonly (string | number)[]
	max?: number
	min?: number
}

function Row({ opt, title, note, type, enums, max, min }: RowProps) {
	const isChanged = createComputed(() => opt() !== opt.getDefault())

	const row = (
		<box class="row" tooltipText={note}>
			<label class="row-title" xalign={0} valign={CENTER} label={title} />

			<box hexpand />

			<box valign={CENTER}>
				<Setter opt={opt} type={type} enums={enums} max={max} min={min} />
				<button
					class="reset"
					valign={CENTER}
					onClicked={() => opt.reset()}
					sensitive={isChanged}
				>
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

const Appearance = () =>
	(
		<Page name="Appearance" iconName={icons.ui.themes}>
			<Group title="Theme">
				<WallpaperChooser />
				<Row
					opt={scheme}
					title="Scheme"
					type="enum"
					enums={optionValues.themeScheme}
				/>
				<Row opt={autotheme} title="Generate from Wallpaper" />
			</Group>

			<Group title="Interface">
				<Row
					opt={uiScale}
					title="Scale"
					min={50}
					max={200}
					note="Scales the whole shell — helps on small or low-res displays"
				/>
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
				<Row
					opt={opacity}
					title="Opacity"
					note="Set to 0 to disable"
					max={70}
				/>
				<Row opt={widget.opacity} title="Widget Opacity" max={100} />
				<Row opt={border.width} title="Border Width" max={100} />
				<Row opt={border.opacity} title="Border Opacity" max={100} />
				<Row
					opt={hyprland.inactiveBorder}
					title="Inactive Border"
					type="color"
				/>
			</Group>

			<Group
				title="Dark Colors"
				visible={scheme.as((value) => value === "dark")}
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
				visible={scheme.as((value) => value === "light")}
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

const Shell = () =>
	(
		<Page name="Shell" iconName={icons.ui.toolbars}>
			<Group title="Bar">
				<Row
					opt={bar.position}
					title="Position"
					type="enum"
					enums={optionValues.barPosition}
				/>
				<Row
					opt={bar.transparent}
					title="Use Transparency"
					note="Works best on minimalist wallpapers"
				/>
				<Row opt={bar.date.format} title="Date Format" />
				<Row opt={bar.corners} title="Corners" max={100} />
				<Row opt={bar.media.preferred} title="Preferred Player" />
			</Group>

			<Group title="Taskbar">
				<Row
					opt={taskbar.location}
					title="Location"
					type="enum"
					enums={optionValues.taskbarLocation}
				/>
				<Row opt={bar.taskbar.exclusive} title="Only Current Workspace" />
			</Group>

			<Group title="Dock">
				<Row
					opt={dock.mode}
					title="Mode"
					type="enum"
					enums={optionValues.dockMode}
				/>
				<Row
					opt={dock.position}
					title="Position"
					type="enum"
					enums={optionValues.dockPosition}
				/>
				<Row opt={dock.scale} title="Scale" min={50} max={200} />
				<Row opt={dock.trash} title="Show Trash" />
			</Group>

			<Group title="Launcher">
				<Row
					opt={launcher.position}
					title="Position"
					type="enum"
					enums={optionValues.launcherPosition}
				/>
				<Row opt={launcher.scale} title="Scale" min={50} max={200} />
				<Row
					opt={favorites.location}
					title="Favorites"
					type="enum"
					enums={optionValues.favoritesLocation}
				/>
				<Row opt={launcher.apps.max} title="Max Items" max={9} />
				<Row opt={bar.launcher.icon} title="Icon" />
			</Group>

			<Group title="Workspaces">
				<Row
					opt={bar.workspaces.count}
					title="Count"
					max={16}
					note="Set to 0 to make it dynamic"
				/>
			</Group>

			<Group title="Overview">
				<Row
					opt={overview.workspaces}
					title="Workspaces"
					max={16}
					note="Set to 0 to make it dynamic"
				/>
				<Row opt={overview.scale} title="Scale" min={50} max={200} />
			</Group>
		</Page>
	) as Gtk.StackPage

const System = () =>
	(
		<Page name="System" iconName={icons.ui.settings}>
			<Group title="Notifications">
				<Row
					opt={notifications.position}
					title="Position"
					type="enum"
					enums={optionValues.popupPosition}
				/>
			</Group>

			<Group title="Desktop">
				<Row opt={desktop.enabled} title="Show Icons" />
				<Row
					opt={desktop.iconSize}
					title="Icon Size"
					type="enum"
					enums={optionValues.desktopIconSize}
				/>
			</Group>

			<Group title="Power Menu">
				<Row
					opt={powermenu.layout}
					title="Layout"
					type="enum"
					enums={optionValues.powerMenuLayout}
				/>
				<Row opt={powermenu.labels} title="Show Labels" />
			</Group>

			<Group title="OSD">
				<Row
					opt={osd.position}
					title="Position"
					type="enum"
					enums={optionValues.osdPosition}
				/>
			</Group>

			<Group title="ASUS" visible={createBinding(asusctl, "available")}>
				<Row
					opt={asus.ac_hz}
					title="Refresh Rate (AC)"
					type="enum"
					enums={asusctl.refreshRates}
				/>
				<Row
					opt={asus.bat_hz}
					title="Refresh Rate (Battery)"
					type="enum"
					enums={asusctl.refreshRates}
				/>
			</Group>
		</Page>
	) as Gtk.StackPage

export const createPages = (): Gtk.StackPage[] => [
	Appearance(),
	Shell(),
	System(),
]
