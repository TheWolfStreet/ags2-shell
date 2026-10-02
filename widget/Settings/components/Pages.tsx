
import { Gdk, Gtk } from "ags/gtk4"
import { Accessor, createBinding, createComputed } from "ags"

import Gio from "gi://Gio"

import Setter, { type EditorType } from "./Setter"

import { Placeholder } from "widget/shared/Placeholder"

import { asusctl } from "$service/asusctl"
import {
	clear_wallpaper,
	set_wallpaper,
	wallpaper_path,
	wallpaper_revision,
} from "$lib/wallpaper"
import { file_exists } from "$lib/files"
import icons from "$lib/icons"
import { notify } from "$lib/notifications"
import { attempt } from "$lib/result"
import { create_square_texture_accessor, hidden_drag_icon } from "$lib/textures"
import { is_dialog_dismissed } from "$lib/ui"

import options, { Opt, option_values } from "$shell/options"

const { START, CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { COVER } = Gtk.ContentFit
const { CROSSFADE } = Gtk.RevealerTransitionType

type PageProps = {
	name: string
	iconName: string
	children?: JSX.Element | Array<JSX.Element>
}

function Page({ name, iconName: icon_name, children = [] }: PageProps) {
	return (
		<Gtk.StackPage
			name={name}
			iconName={icon_name}
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
	const is_set = wallpaper_revision.as(() => {
		const size = attempt(() => Gio.File.new_for_path(wallpaper_path)
			.query_info("standard::size", Gio.FileQueryInfoFlags.NONE, null).get_size())
		return size.ok && size.value > 0
	})
	const preview_texture = createComputed(() => {
		wallpaper_revision()
		return create_square_texture_accessor(wallpaper_path, 256)
	})
	const preview = createComputed(() => preview_texture()() ?? hidden_drag_icon())
	let dialog: Gtk.FileDialog
	let dialog_open = false

	function open_dialog() {
		if (dialog_open) return
		dialog_open = true

		const opened = attempt(() => {
			if (!dialog) {
				dialog = new Gtk.FileDialog({ title: "Set wallpaper", modal: true })
				const filter = new Gtk.FileFilter()
				filter.set_name("Images")
				filter.add_mime_type("image/*")
				dialog.set_default_filter(filter)
			}
			if (file_exists(wallpaper_path))
				dialog.set_initial_file(Gio.File.new_for_path(wallpaper_path))

			dialog.open(null, null, (_, result) => {
				dialog_open = false
				if (!result) return

				const outcome = attempt(
					() => dialog.open_finish(result)?.get_path() ?? null,
				)
				if (outcome.ok) {
					if (outcome.value) void set_wallpaper(outcome.value).then((saved) => {
						if (!saved.ok) {
							console.error("wallpaper.dialog: Failed to set wallpaper", saved.err)
							void notify({ app_name: "Wallpaper", summary: "Could not set wallpaper", body: String(saved.err), urgency: "critical" })
						}
					})
					return
				}

				if (!is_dialog_dismissed(outcome.err))
					console.error(
						"wallpaper.dialog: Failed to choose wallpaper",
						outcome.err,
					)
			})
		})

		if (!opened.ok) {
			dialog_open = false
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
				tooltipText={is_set.as((set) => (set ? "Middle-click to clear" : ""))}
			>
				<Gtk.GestureClick button={Gdk.BUTTON_PRIMARY} onPressed={open_dialog} />
				<Gtk.GestureClick
					button={Gdk.BUTTON_MIDDLE}
					onPressed={clear_wallpaper}
				/>
				<revealer
					transitionDuration={options.transition.duration.as(
						(value) => value * 4,
					)}
					revealChild={is_set.as((set) => !set)}
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
					paintable={preview}
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

const option_by_row = new WeakMap<object, Opt<any>>()

function collect_row_options(children: JSX.Element | JSX.Element[]) {
	return (Array.isArray(children) ? children : [children])
		.map((child) =>
			child && typeof child === "object" ? option_by_row.get(child) : undefined,
		)
		.filter((opt): opt is Opt<any> => opt !== undefined)
}

function Group({ title, visible = true, children = [] }: GroupProps) {
	const group_options = collect_row_options(children)
	const any_changed =
		group_options.length > 0
			? createComputed(() =>
					group_options.some((opt) => opt() !== opt.get_default()),
				)
			: false

	const reset_group = () => group_options.forEach((opt) => opt.reset())

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
					onClicked={reset_group}
					sensitive={any_changed}
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
	enums?: readonly (string | number)[] | Accessor<readonly (string | number)[]>
	max?: number
	min?: number
}

function Row({ opt, title, note, type, enums, max, min }: RowProps) {
	const is_changed = createComputed(() => opt() !== opt.get_default())

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
					sensitive={is_changed}
				>
					<image iconName={icons.ui.refresh} useFallback />
				</button>
			</box>
		</box>
	) as Gtk.Box
	option_by_row.set(row, opt)
	return row
}

const {
	autotheme,
	scale: ui_scale,
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
					enums={option_values.theme_scheme}
				/>
				<Row opt={autotheme} title="Generate from Wallpaper" />
			</Group>

			<Group title="Interface">
				<Row
					opt={ui_scale}
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
					enums={option_values.bar_position}
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
					enums={option_values.taskbar_location}
				/>
				<Row opt={bar.taskbar.exclusive} title="Only Current Workspace" />
			</Group>

			<Group title="Dock">
				<Row
					opt={dock.mode}
					title="Mode"
					type="enum"
					enums={option_values.dock_mode}
				/>
				<Row
					opt={dock.position}
					title="Position"
					type="enum"
					enums={option_values.dock_position}
				/>
				<Row opt={dock.scale} title="Scale" min={50} max={200} />
				<Row opt={dock.trash} title="Show Trash" />
			</Group>

			<Group title="Launcher">
				<Row
					opt={launcher.position}
					title="Position"
					type="enum"
					enums={option_values.launcher_position}
				/>
				<Row opt={launcher.scale} title="Scale" min={50} max={200} />
				<Row
					opt={favorites.location}
					title="Favorites"
					type="enum"
					enums={option_values.favorites_location}
				/>
				<Row opt={launcher.apps.max} title="Max Items" min={0} max={9} />
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
					enums={option_values.popup_position}
				/>
			</Group>

			<Group title="Desktop">
				<Row opt={desktop.enabled} title="Show Icons" />
				<Row
					opt={desktop.iconSize}
					title="Icon Size"
					type="enum"
					enums={option_values.desktop_icon_size}
				/>
			</Group>

			<Group title="Power Menu">
				<Row
					opt={powermenu.layout}
					title="Layout"
					type="enum"
					enums={option_values.power_menu_layout}
				/>
				<Row opt={powermenu.labels} title="Show Labels" />
			</Group>

			<Group title="OSD">
				<Row
					opt={osd.position}
					title="Position"
					type="enum"
					enums={option_values.osd_position}
				/>
			</Group>

			<Group title="ASUS" visible={createBinding(asusctl, "available")}>
				<Row
					opt={asus.ac_hz}
					title="Refresh Rate (AC)"
					type="enum"
					enums={createBinding(asusctl, "refreshRates")}
				/>
				<Row
					opt={asus.bat_hz}
					title="Refresh Rate (Battery)"
					type="enum"
					enums={createBinding(asusctl, "refreshRates")}
				/>
			</Group>
		</Page>
	) as Gtk.StackPage

export const create_pages = (): Gtk.StackPage[] => [
	Appearance(),
	Shell(),
	System(),
]
