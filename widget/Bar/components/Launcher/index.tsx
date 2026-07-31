// Shows a searchable application list and handles keyboard and pointer input.

import app from "ags/gtk4/app"
import { Accessor, createBinding, createComputed, createState, For, onCleanup, With } from "ags"
import { Astal, Gtk, Gdk } from "ags/gtk4"

import AstalApps from "gi://AstalApps"

import { Placeholder } from "widget/Placeholder"
import { PopupWindow, Position } from "widget/Windowing/PopupWindow"
import { PanelButton } from "../PanelButton"

import { Opt } from "$lib/option"
import { applications } from "$service/applications"
import icons from "$lib/icons"
import { toggleWindow } from "widget/Windowing/WindowControl"

import options from "options"

const { OVERLAY } = Astal.Layer
const { NORMAL } = Astal.Exclusivity
const { ON_DEMAND } = Astal.Keymode

const { SLIDE_DOWN, SLIDE_UP } = Gtk.RevealerTransitionType
const { VERTICAL } = Gtk.Orientation
const { CENTER, END } = Gtk.Align

const { LEFT } = Gtk.Justification
const { ALT_MASK } = Gdk.ModifierType
const ALT_DIGIT_KEYS = [
	Gdk.KEY_1,
	Gdk.KEY_2,
	Gdk.KEY_3,
	Gdk.KEY_4,
	Gdk.KEY_5,
	Gdk.KEY_6,
	Gdk.KEY_7,
	Gdk.KEY_8,
	Gdk.KEY_9,
] as const

const { position } = options.launcher

type FavoritesProps = {
	favorites: Accessor<AstalApps.Application[]>
	visible: Accessor<boolean>
	launch: (a: AstalApps.Application) => void
}

type AppListProps = {
	allApps: Accessor<AstalApps.Application[]>
	visibleApps: Accessor<AstalApps.Application[]>
	launch: (a: AstalApps.Application) => void
}

type AppEntryProps = {
	app: AstalApps.Application
	visibleApps: Accessor<AstalApps.Application[]>
	launch: (app: AstalApps.Application) => void
}

type IndexedApplication = {
	app: AstalApps.Application
	name: string
}

function indexApplications(applications: AstalApps.Application[]): IndexedApplication[] {
	return applications.map(app => ({ app, name: app.get_name().toLowerCase() }))
}

function rankApplications(index: IndexedApplication[], query: string, limit: number) {
	const normalizedQuery = query.trim().toLowerCase()
	if (!normalizedQuery) return []

	return index
		.map(indexed => ({ ...indexed, matchPosition: indexed.name.indexOf(normalizedQuery) }))
		.filter(result => result.matchPosition >= 0)
		.sort((left, right) => {
			if (left.matchPosition !== right.matchPosition)
				return left.matchPosition - right.matchPosition
			return left.name.localeCompare(right.name)
		})
		.slice(0, limit)
		.map(result => result.app)
}

export namespace Launcher {
	const allApps = createBinding(applications, "list")
	const launcherScale = createComputed(() => Math.max(0.5, options.launcher.scale() / 100))
	const iconSize = createComputed(() => Math.round(64 * options.scale() / 100 * launcherScale()))
	const revealers = new Map<string, Gtk.Revealer>()
	const isOnBottom = createComputed(() => position() === "bottom-center")
	const appTransition = isOnBottom.as(isBottom => isBottom ? SLIDE_UP : SLIDE_DOWN)

	function orderApps<T>(apps: T[]) {
		return isOnBottom.peek() ? [...apps].reverse() : apps
	}

	let appsBox: Gtk.Box | undefined
	let prevOrder: string[] = []
	function updateRevealers(visibleApps: AstalApps.Application[]) {
		const orderedVisibleApps = orderApps(visibleApps)
		const visibleNames = new Set(orderedVisibleApps.map(app => app.get_name()))
		const currentOrder = orderedVisibleApps.map(app => app.get_name())

		if (!appsBox) {
			revealers.forEach((revealer, appName) => {
				revealer.set_reveal_child(visibleNames.has(appName))
			})
			return
		}

		const orderChanged = currentOrder.length !== prevOrder.length ||
			currentOrder.some((name, orderIndex) => name !== prevOrder[orderIndex])

		if (orderChanged) {
			for (let orderIndex = 0; orderIndex < currentOrder.length; orderIndex++) {
				const revealer = revealers.get(currentOrder[orderIndex])
				if (revealer && !revealer.get_reveal_child()) {
					appsBox.reorder_child_after(
						revealer,
						orderIndex === 0 ? null : revealers.get(currentOrder[orderIndex - 1]) ?? null
					)
				}
			}

			prevOrder = currentOrder
		}

		revealers.forEach((revealer, appName) => {
			revealer.set_reveal_child(visibleNames.has(appName))
		})
	}

	function launchApp(win: Astal.Window, app?: AstalApps.Application) {
		if (app) {
			win.hide()
			app.launch()
		}
	}

	function Favorites({
		favorites,
		visible,
		launch,
	}: FavoritesProps) {
		const quickLaunch = (
			<box class="quicklaunch horizontal">
				<For each={favorites}>
					{(app: AstalApps.Application) =>
						app ? (
							<button tooltipText={app.get_name()} onClicked={() => launch(app)} hexpand>
								<image
									iconName={app.get_icon_name()}
									pixelSize={iconSize}
								/>
							</button>
						) : (
							<box visible={false} />
						)
					}
				</For>
			</box>
		)

		return (
			<revealer
				revealChild={visible}
				transitionDuration={options.transition.duration}
				transitionType={appTransition}
			>
				<box orientation={VERTICAL}>
					<Gtk.Separator visible={isOnBottom.as(b => !b)} />
					{quickLaunch}
					<Gtk.Separator visible={isOnBottom} />
				</box>
			</revealer>
		)
	}

	function AppEntry({ app, visibleApps, launch }: AppEntryProps) {
		const appName = app.get_name()
		const [iconReady, setIconReady] = createState(false)
		const hint = visibleApps.as(apps => {
			const matchRank = apps.findIndex(candidate => candidate.get_name() === appName)
			return matchRank >= 0 && matchRank < 9 ? `󰘳 ${matchRank + 1}` : ""
		})

		const appButton = (
			<button class="app-item" onClicked={() => launch(app)}>
				<box>
					<image
						iconName={iconReady.as(ready => ready ? app.get_icon_name() : "")}
						pixelSize={iconSize}
						useFallback
					/>
					<box valign={CENTER} orientation={VERTICAL}>
						<label class="title" hexpand xalign={0} label={app.name} />
						{app.description && (
							<label
								class="description"
								hexpand
								wrap
								maxWidthChars={30}
								justify={LEFT}
								valign={CENTER}
								xalign={0}
								label={app.description}
							/>
						)}
					</box>
					<label class="launch-hint" hexpand halign={END} label={hint} />
				</box>
			</button>
		)

		return (
			<revealer
				name={appName}
				transitionType={appTransition}
				transitionDuration={options.transition.duration}
				revealChild={false}
				$={r => {
					revealers.set(appName, r)
					const revealHandler = r.connect("notify::reveal-child", () => {
						if (r.get_reveal_child()) setIconReady(true)
					})
					onCleanup(() => {
						r.disconnect(revealHandler)
						revealers.delete(appName)
					})
				}}
			>
				<box orientation={VERTICAL}>
					<Gtk.Separator visible={isOnBottom.as(b => !b)} />
					{appButton}
					<Gtk.Separator visible={isOnBottom} />
				</box>
			</revealer>
		) as Gtk.Revealer
	}

	function AppList({
		allApps,
		visibleApps,
		launch,
	}: AppListProps) {
		const orderedApps = createComputed(() => orderApps(allApps()))
		return (
			<box
				orientation={VERTICAL}
				$={self => {
					appsBox = self
					const unsub = visibleApps.subscribe(() => updateRevealers(visibleApps.peek()))
					onCleanup(() => {
						unsub()
						revealers.clear()
						prevOrder = []
					})
				}}
			>
				<For each={orderedApps}>
					{(app: AstalApps.Application) => <AppEntry app={app} visibleApps={visibleApps} launch={launch} />}
				</For>
			</box>
		)
	}

	let entry: Gtk.Entry | undefined
	let launcherWin: Astal.Window | undefined
	export function setSearchQuery(query: string, ensureVisible = true) {
		const window = launcherWin ?? app.get_window("launcher") as Astal.Window | null
		if (!window)
			return

		if (ensureVisible && !window.visible) {
			window.show()
		}

		if (entry) {
			entry.grab_focus()
			entry.set_text(query)
		}
	}

	export function Button() {
		return (
			<PanelButton
				name="launcher"
				onClicked={() => toggleWindow("launcher")}
			>
				<box class="launcher horizontal">
					<image iconName={options.bar.launcher.icon} useFallback />
				</box>
			</PanelButton>
		)
	}

	export function Window() {
		let win: Astal.Window

		const [text, setText] = createState("")
		const favorites = createBinding(applications, "favorites")
		const searchIndex = createComputed(() => indexApplications(allApps()))
		const visibleApps = createComputed(() => {
			const maxVisible = options.launcher.apps.max.peek() || 9
			return rankApplications(searchIndex(), text(), maxVisible)
		})

		function favsVisible(location: string) {
			return location === "launcher" || location === "both"
		}

		function getAltDigitKey(index: number) {
			return ALT_DIGIT_KEYS[index]
		}

		function onKey(
			win: Astal.Window,
			keyval: number,
			mod: number,
			visibleApps: AstalApps.Application[],
			favorites: AstalApps.Application[],
		) {
			if (mod !== ALT_MASK) return

			for (let i = 0; i < Math.min(visibleApps.length, 9); i++) {
				const key = getAltDigitKey(i)
				if (keyval === key) {
					launchApp(win, visibleApps[i])
					return
				}
			}

			if (visibleApps.length === 0 && favsVisible(options.favorites.location.peek())) {
				for (let i = 0; i < Math.min(favorites.length, 9); i++) {
					const key = getAltDigitKey(i)
					if (keyval === key) {
						launchApp(win, favorites[i])
						return
					}
				}
			}
		}

		const orderedVisibleApps = createComputed(() => orderApps(visibleApps()))
		const notFound = createComputed(() => text().length > 0 && visibleApps().length === 0)
		const showFavorites = createComputed(() => text().length === 0 && favsVisible(options.favorites.location()))

		const SearchEntry = () => (
			<entry
				$={e => {
					entry = e
				}}
				placeholderText="Search"
				primaryIconName="system-search-symbolic"
				onNotifyText={e => setText(e.text)}
			/>
		)

		const NotFoundRevealer = () => (
			<revealer
				halign={CENTER}
				revealChild={notFound}
				transitionType={appTransition}
				transitionDuration={options.transition.duration}
			>
				<Placeholder iconName={icons.ui.search} iconSize={iconSize} label="No results found" />
			</revealer>
		)

		const FavoritesSection = () => (
			<Favorites favorites={favorites} visible={showFavorites} launch={a => launchApp(win, a)} />
		)

		const AppListSection = () => (
			<AppList allApps={allApps} visibleApps={visibleApps} launch={a => launchApp(win, a)} />
		)

		const TopContent = () => (
			<>
				<SearchEntry />
				<NotFoundRevealer />
				<FavoritesSection />
				<AppListSection />
			</>
		)

		const BottomContent = () => (
			<>
				<AppListSection />
				<FavoritesSection />
				<NotFoundRevealer />
				<SearchEntry />
			</>
		)

		const launcherCss = createComputed(() => {
			const componentScale = launcherScale()
			const margin = options.launcher.margin() * options.scale() / 100 * componentScale
			const positionMargin = position() === "bottom-center"
				? `margin-bottom: ${margin}pt;`
				: `margin-top: ${margin}pt;`

			return [
				positionMargin,
				`--padding: calc(var(--ui-padding) * ${componentScale});`,
				`--spacing: calc(var(--ui-spacing) * ${componentScale});`,
				`--radius: calc(var(--ui-radius) * ${componentScale});`,
				`--border-width: calc(var(--ui-border-width) * ${componentScale});`,
				`--font-size: calc(var(--ui-font-size) * ${componentScale});`,
				`--icon-size: calc(var(--ui-icon-size) * ${componentScale});`,
				`--popover-padding: calc(var(--ui-popover-padding) * ${componentScale});`,
				`--popover-radius: calc(var(--ui-popover-radius) * ${componentScale});`,
				`--scale: ${Math.max(0.1, options.scale() / 100) * componentScale};`,
			].join("")
		})

		return (
			<PopupWindow
				name="launcher"
				exclusivity={NORMAL}
				keymode={ON_DEMAND}
				layer={OVERLAY}
				layout={position as Opt<Position>}
				application={app}
				onKey={(_ctrl, keyval, _code, mod) => onKey(win, keyval, mod, orderedVisibleApps.peek(), favorites.peek())}
				$={w => {
					win = w
					launcherWin = w
				}}
				onNotifyVisible={w => {
					if (w.visible) {
						entry?.grab_focus()
					} else {
						entry?.set_text("")
					}
				}}
			>
				<With value={isOnBottom}>
					{isBottom => (
						<box
							class="launcher"
							orientation={VERTICAL}
							css={launcherCss}
						>
							{isBottom ? <BottomContent /> : <TopContent />}
						</box>
					)}
				</With>
			</PopupWindow>
		) as Gtk.Window
	}
}
