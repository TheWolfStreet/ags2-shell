import app from "ags/gtk4/app"
import { createBinding, createState, For, createComputed, onCleanup } from "ags"
import { Astal, Gtk, Gdk } from "ags/gtk4"
import { timeout, Timer } from "ags/time"

import AstalApps from "gi://AstalApps"
import AstalHyprland from "gi://AstalHyprland"

import { apps, hypr } from "$lib/services"
import options from "options"

const { HORIZONTAL, VERTICAL } = Gtk.Orientation
const { CENTER } = Gtk.Align
const { BUTTON_PRIMARY, BUTTON_SECONDARY, BUTTON_MIDDLE } = Gdk

export namespace Dock {

	enum Mode {
		STATIC,
		AUTOHIDE,
		WINDOWHIDE
	}

	type AppGroup = {
		appClass: string
		instances: AstalHyprland.Client[]
		isRunning: boolean
	}

	type DockItem = {
		type: 'running' | 'favorite'
		app?: AstalApps.Application
		group?: AppGroup
	}

	const [launching, setLaunching] = createState<string | null>(null)
	const favorites = createBinding(apps, "favorites")
	const runningApps = createBinding(hypr, "clients").as(clients =>
		[...(clients ?? [])].filter(c => c?.class !== "")
	)

	const groupedApps = runningApps.as(apps => {
		const appGroups = new Map<string, AstalHyprland.Client[]>()

		apps.forEach(client => {
			const appClass = client.get_class()
			if (!appGroups.has(appClass)) {
				appGroups.set(appClass, [])
			}
			appGroups.get(appClass)!.push(client)
		})

		return Array.from(appGroups.entries()).map(([appClass, instances]) => ({
			appClass,
			instances: instances.sort((a, b) => (a?.workspace?.id ?? 0) - (b?.workspace?.id ?? 0)),
			isRunning: instances.length > 0
		}))
	})

	function findRunningInstanceFor(fav: AstalApps.Application, runningApps: AppGroup[]) {
		const name = fav.get_name().toLowerCase()
		const exec = fav.get_executable()?.toLowerCase() || ""
		const entry = fav.get_entry()?.toLowerCase() || ""

		return runningApps.find(group => {
			if (!group.appClass) return false
			const classname = group.appClass.toLowerCase()

			if (classname === name || classname === exec || classname === entry) {
				return true
			}

			if (classname.includes(name) || name.includes(classname)) {
				return true
			}

			if (classname.includes(exec) || exec.includes(classname)) {
				return true
			}

			return false
		})
	}

	const items = createComputed([favorites, groupedApps], (favorites, runningApps) => {
		const dockItems: DockItem[] = []

		favorites.forEach(fav => {
			const matching = findRunningInstanceFor(fav, runningApps)

			if (matching) {
				dockItems.push({ type: 'running', group: matching })
			} else {
				dockItems.push({ type: 'favorite', app: fav })
			}
		})

		runningApps.forEach(runningApp => {
			const alreadyPresent = dockItems.some(item =>
				item.group?.appClass === runningApp.appClass
			)

			if (!alreadyPresent) {
				dockItems.push({ type: 'running', group: runningApp })
			}
		})

		return dockItems
	})

	function FavoriteAppIcon({ app }: { app: AstalApps.Application }) {
		const appName = app.get_name()
		const isLaunching = launching.as(l => l === appName)
		const buttonClass = isLaunching.as(launching =>
			launching ? 'app-button launching' : 'app-button'
		)

		function handleLaunch() {
			setLaunching(appName)
			app.launch()
			setTimeout(() => setLaunching(null), 250)
		}

		return (
			<box class="dock-icon" orientation={VERTICAL} halign={CENTER}>
				<button class={buttonClass} tooltipText={appName} onClicked={handleLaunch}>
					<image
						halign={CENTER}
						valign={CENTER}
						iconName={app.get_icon_name()}
						pixelSize={64}
					/>
				</button>
			</box>
		)
	}

	function RunningAppIcon({ appClass, instances, isRunning }: AppGroup) {
		if (!instances.length) {
			return <box visible={false} />
		}

		const count = instances.length
		const suffix = count > 1 ? 's' : ''
		const tooltip = `${appClass} (${count} window${suffix})`

		function focusApp() {
			const focused = hypr.get_focused_client()
			const active = instances.find(c => c.address === focused?.address)

			if (active && instances.length > 1) {
				const current = instances.indexOf(active)
				const next = instances[(current + 1) % instances.length]
				next.focus()
			} else {
				instances[0].focus()
			}
		}

		function makeFullscreen() {
			const focused = hypr.get_focused_client()
			const active = instances.find(c => c.address === focused?.address)
			const target = active || instances[0]

			target.focus()
			hypr.message("dispatch fullscreen")
		}

		function closeApp() {
			instances.forEach(client => client.kill())
		}

		function onPressed(self: Gtk.GestureClick) {
			const button = self.get_current_button()

			if (button === BUTTON_PRIMARY) focusApp()
			if (button === BUTTON_SECONDARY) makeFullscreen()
			if (button === BUTTON_MIDDLE) closeApp()

			self.reset()
		}

		return (
			<box class="dock-icon" orientation={VERTICAL} halign={CENTER}>
				<button class="app-button" tooltipText={tooltip}>
					<Gtk.GestureClick button={0} onPressed={onPressed} />
					<image
						halign={CENTER}
						valign={CENTER}
						iconName={appClass}
						pixelSize={64}
						useFallback
					/>
				</button>
				<box
					class="focused"
					visible={isRunning}
					halign={CENTER}
				/>
			</box>
		)
	}

	function DockContainer() {
		function dockItem(item: DockItem) {
			if (item.type === 'running' && item.group) {
				return <RunningAppIcon {...item.group} />
			}

			if (item.type === 'favorite' && item.app) {
				return <FavoriteAppIcon app={item.app} />
			}

			return <box visible={false} />
		}

		return (
			<box class="dock-container" orientation={HORIZONTAL} halign={CENTER}>
				<For each={items}>
					{dockItem}
				</For>
			</box>
		)
	}

	export function Window({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
		const [revealed, setRevealed] = createState(false)
		let hoverTimeout: Timer | undefined
		let win: Astal.Window

		const unsubscribe = options.dock.autohide.subscribe(() => {
			if (win) {
				win.queue_draw()
			}
		})

		onCleanup(() => {
			unsubscribe()
			if (hoverTimeout) hoverTimeout.cancel()
		})

		const dockClass = createComputed([options.dock.autohide, revealed], (mode, isRevealed) => {
			if (mode === "hover") {
				return isRevealed ? "visible" : "hidden"
			}
			return ""
		})

		return (
			<window
				$={self => win = self}
				name="dock"
				layer={Astal.Layer.TOP}
				exclusivity={options.dock.autohide.as(mode =>
					mode === "exclusive" ? Astal.Exclusivity.EXCLUSIVE : Astal.Exclusivity.IGNORE
				)}
				anchor={options.dock.position.as(pos =>
					pos === "bottom" ? Astal.WindowAnchor.BOTTOM : Astal.WindowAnchor.TOP
				)}
				visible={options.dock.style.as(s => s === "bottom")}
				application={app}
				marginBottom={4}
				gdkmonitor={gdkmonitor}
			>
				<Gtk.EventControllerMotion
					onEnter={() => {
						if (options.dock.autohide.peek() === "hover") {
							if (hoverTimeout) hoverTimeout.cancel()
							setRevealed(true)
						}
					}}
					onLeave={() => {
						if (options.dock.autohide.peek() === "hover") {
							if (hoverTimeout) hoverTimeout.cancel()
							hoverTimeout = timeout(500, () => setRevealed(false))
						}
					}}
				/>
				<box class={dockClass.as(c => c ? `dock ${c}` : "dock")} orientation={HORIZONTAL} halign={CENTER}>
					<DockContainer />
				</box>
			</window>
		) as Gtk.Window
	}

}
