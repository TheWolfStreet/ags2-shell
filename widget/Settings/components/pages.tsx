import { Gdk, Gtk } from "ags/gtk4"
import { createBinding, createComputed } from "ags"

import Gio from "gi://Gio"

import Setter, { type setter_props } from "./Setter"

import { Placeholder } from "widget/shared/Placeholder"

import { asusctl } from "$service/asusctl"
import {
	clear_wallpaper,
	set_wallpaper,
	wallpaper_path,
	wallpaper_revision,
} from "$lib/wallpaper"
import { file_exists, file_size } from "$lib/files"
import icons from "$lib/icons"
import { notify } from "$lib/notifications"
import { attempt, log_error } from "$lib/result"
import { create_texture_accessor, hidden_drag_icon } from "$lib/textures"
import { is_dialog_dismissed, type maybe_accessor } from "$lib/ui"

import options, { Opt, scaled } from "$shell/options"

const { START, CENTER, END } = Gtk.Align
const { VERTICAL } = Gtk.Orientation
const { COVER } = Gtk.ContentFit
const { CROSSFADE } = Gtk.RevealerTransitionType

type page_props = {
	name: string
	iconName: string
	children?: JSX.Element | Array<JSX.Element>
}

function Page({ name, iconName: icon_name, children = [] }: page_props) {
	return (
		<Gtk.StackPage
			name={name}
			iconName={icon_name}
			child={
				(
					<Gtk.ScrolledWindow
						class="page"
						css={scaled(300).as((px) => `min-height: ${px}px;`)}
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

async function save_wallpaper(path: string) {
	const saved = await set_wallpaper(path)
	if (saved.ok) return
	console.error("wallpaper.dialog: Failed to set wallpaper", saved.err)
	void notify({
		app_name: "Wallpaper",
		summary: "Could not set wallpaper",
		body: String(saved.err),
		urgency: "critical",
	})
}

function WallpaperChooser() {
	const is_set = wallpaper_revision.as(() => {
		const size = file_size(wallpaper_path)
		return size.ok && size.value > 0
	})
	const preview_texture = createComputed(() => {
		wallpaper_revision()
		return create_texture_accessor(wallpaper_path, 256)
	})
	const preview = createComputed(
		() => preview_texture()() ?? hidden_drag_icon(),
	)
	let dialog: Gtk.FileDialog | null = null
	let dialog_open = false

	function ensure_dialog() {
		if (dialog) return dialog
		dialog = new Gtk.FileDialog({ title: "Set wallpaper", modal: true })
		const filter = new Gtk.FileFilter()
		filter.set_name("Images")
		filter.add_mime_type("image/*")
		dialog.set_default_filter(filter)
		return dialog
	}

	function apply_choice(chooser: Gtk.FileDialog, result: Gio.AsyncResult) {
		const chosen = attempt(
			() => chooser.open_finish(result)?.get_path() ?? null,
		)
		if (!chosen.ok) {
			if (!is_dialog_dismissed(chosen.err))
				console.error(
					"wallpaper.dialog: Failed to choose wallpaper",
					chosen.err,
				)
			return
		}
		if (chosen.value) void save_wallpaper(chosen.value)
	}

	function open_dialog() {
		if (dialog_open) return
		dialog_open = true

		const opened = attempt(() => {
			const chooser = ensure_dialog()
			if (file_exists(wallpaper_path))
				chooser.set_initial_file(Gio.File.new_for_path(wallpaper_path))
			chooser.open(null, null, (_source, result) => {
				dialog_open = false
				if (result) apply_choice(chooser, result)
			})
		})
		if (opened.ok) return
		dialog_open = false
		log_error(opened, "wallpaper.dialog: Failed to open wallpaper chooser")
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

type group_props = {
	title: maybe_accessor<string>
	visible?: maybe_accessor<boolean>
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

function Group({ title, visible = true, children = [] }: group_props) {
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

type row_props = setter_props & {
	title: string
	note?: string
}

function Row({ opt, title, note, enums }: row_props) {
	const is_changed = createComputed(() => opt() !== opt.get_default())

	const row = (
		<box class="row" tooltipText={note}>
			<label class="row-title" xalign={0} valign={CENTER} label={title} />

			<box hexpand />

			<box valign={CENTER}>
				<Setter opt={opt} enums={enums} />
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
	tmux,
	asus,
} = options

const {
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

function SchemeColors({
	name,
	title,
}: {
	name: "dark" | "light"
	title: string
}) {
	const colors = theme[name]
	return (
		<Group title={title} visible={scheme.as((value) => value === name)}>
			<Row opt={colors.primary.bg} title="Primary" />
			<Row opt={colors.bg} title="Background" />
			<Row opt={colors.fg} title="Foreground" />
			<Row opt={colors.primary.fg} title="On Primary" />
			<Row opt={colors.widget} title="Widget" />
			<Row opt={colors.border} title="Border" />
			<Row opt={colors.error.bg} title="Error" />
		</Group>
	)
}

function Appearance() {
	return (
		<Page name="Appearance" iconName={icons.ui.themes}>
			<Group title="Theme">
				<WallpaperChooser />
				<Row opt={scheme} title="Scheme" />
				<Row opt={autotheme} title="Generate from Wallpaper" />
				<Row
					opt={tmux.accent}
					title="Sync Accent to tmux"
					note="Sets tmux @main_accent to the primary color"
				/>
			</Group>

			<Group title="Interface">
				<Row
					opt={ui_scale}
					title="Scale"
					note="Scales the whole shell — helps on small or low-res displays"
				/>
				<Row opt={font} title="Font" />
				<Row opt={roundness} title="Roundness" />
				<Row opt={spacing} title="Spacing" />
				<Row opt={padding} title="Padding" />
				<Row opt={transition.duration} title="Animation Duration" />
			</Group>

			<Group title="Effects">
				<Row opt={blur} title="Enable Blur" />
				<Row opt={shadows} title="Show Shadows" />
				<Row opt={neumorphic} title="Use Neumorphic Style" />
				<Row opt={opacity} title="Opacity" note="Set to 0 to disable" />
				<Row opt={widget.opacity} title="Widget Opacity" />
				<Row opt={border.width} title="Border Width" />
				<Row opt={border.opacity} title="Border Opacity" />
				<Row opt={hyprland.inactiveBorder} title="Inactive Border" />
			</Group>

			<SchemeColors name="dark" title="Dark Colors" />
			<SchemeColors name="light" title="Light Colors" />
		</Page>
	) as Gtk.StackPage
}

function Shell() {
	return (
		<Page name="Shell" iconName={icons.ui.toolbars}>
			<Group title="Bar">
				<Row opt={bar.position} title="Position" />
				<Row
					opt={bar.transparent}
					title="Use Transparency"
					note="Works best on minimalist wallpapers"
				/>
				<Row opt={bar.date.format} title="Date Format" />
				<Row opt={bar.corners} title="Corners" />
				<Row opt={bar.media.preferred} title="Preferred Player" />
			</Group>

			<Group title="Taskbar">
				<Row opt={taskbar.location} title="Location" />
				<Row opt={bar.taskbar.exclusive} title="Only Current Workspace" />
			</Group>

			<Group title="Dock">
				<Row opt={dock.mode} title="Mode" />
				<Row opt={dock.position} title="Position" />
				<Row opt={dock.scale} title="Scale" />
				<Row opt={dock.trash} title="Show Trash" />
			</Group>

			<Group title="Launcher">
				<Row opt={launcher.position} title="Position" />
				<Row opt={launcher.scale} title="Scale" />
				<Row opt={favorites.location} title="Favorites" />
				<Row opt={launcher.apps.max} title="Max Items" />
				<Row opt={bar.launcher.icon} title="Icon" />
			</Group>

			<Group title="Workspaces">
				<Row
					opt={bar.workspaces.count}
					title="Count"
					note="Set to 0 to make it dynamic"
				/>
			</Group>

			<Group title="Overview">
				<Row
					opt={overview.workspaces}
					title="Workspaces"
					note="Set to 0 to make it dynamic"
				/>
				<Row opt={overview.scale} title="Scale" />
			</Group>
		</Page>
	) as Gtk.StackPage
}

function System() {
	const refresh_rates = createBinding(asusctl, "refreshRates")
	return (
		<Page name="System" iconName={icons.ui.settings}>
			<Group title="Notifications">
				<Row opt={notifications.position} title="Position" />
			</Group>

			<Group title="Desktop">
				<Row opt={desktop.enabled} title="Show Icons" />
				<Row opt={desktop.iconSize} title="Icon Size" />
			</Group>

			<Group title="Power Menu">
				<Row opt={powermenu.layout} title="Layout" />
				<Row opt={powermenu.labels} title="Show Labels" />
			</Group>

			<Group title="OSD">
				<Row opt={osd.position} title="Position" />
			</Group>

			<Group title="ASUS" visible={createBinding(asusctl, "available")}>
				<Row opt={asus.ac_hz} title="Refresh Rate (AC)" enums={refresh_rates} />
				<Row
					opt={asus.bat_hz}
					title="Refresh Rate (Battery)"
					enums={refresh_rates}
				/>
			</Group>
		</Page>
	) as Gtk.StackPage
}

export function create_pages(): Gtk.StackPage[] {
	return [Appearance(), Shell(), System()]
}
