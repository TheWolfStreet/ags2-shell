import app from "ags/gtk4/app"
import { createBinding, createState, For, createComputed } from "ags"
import { Astal, Gtk, Gdk } from "ags/gtk4"

import AstalApps from "gi://AstalApps"
import AstalHyprland from "gi://AstalHyprland"

import { apps, hypr } from "$lib/services"

const { Orientation, Align } = Gtk
const { BUTTON_PRIMARY, BUTTON_SECONDARY, BUTTON_MIDDLE } = Gdk

export namespace Dock {
	const [launching, setLaunching] = createState<string | null>(null)
	const allFavs = createBinding(apps, "favorites")

	const allClients = createBinding(hypr, "clients").as(clients =>
		[...(clients ?? [])].filter(c => c?.class !== "")
	)

	const groupedApps = allClients.as(clients => {
		const appGroups = new Map<string, AstalHyprland.Client[]>()

		clients.forEach(client => {
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

	function findMatchingRunningApp(fav: AstalApps.Application, runningApps: typeof groupedApps.get) {
		const favName = fav.get_name().toLowerCase()
		const favExec = fav.get_executable()?.toLowerCase() || ""
		const favEntry = fav.get_entry()?.toLowerCase() || ""

		return runningApps.find(group => {
			if (!group.appClass) return false
			const appClass = group.appClass.toLowerCase()

			if (appClass === favName || appClass === favExec || appClass === favEntry) {
				return true
			}

			if (appClass.includes(favName) || favName.includes(appClass)) {
				return true
			}

			if (appClass.includes(favExec) || favExec.includes(appClass)) {
				return true
			}

			return false
		})
	}

	const mergedDockItems = createComputed([allFavs, groupedApps], (favorites, runningApps) => {
		const dockItems: Array<{
			type: 'running' | 'favorite'
			app?: AstalApps.Application
			group?: typeof runningApps[0]
		}> = []

		favorites.forEach(fav => {
			const matchingRunningApp = findMatchingRunningApp(fav, runningApps)

			if (matchingRunningApp) {
				dockItems.push({ type: 'running', group: matchingRunningApp })
			} else {
				dockItems.push({ type: 'favorite', app: fav })
			}
		})

		runningApps.forEach(runningApp => {
			const alreadyInDock = dockItems.some(item =>
				item.group?.appClass === runningApp.appClass
			)

			if (!alreadyInDock) {
				dockItems.push({ type: 'running', group: runningApp })
			}
		})

		return dockItems
	})


	function RunningAppIcon({ appClass, instances, isRunning }: {
		appClass: string
		instances: AstalHyprland.Client[]
		isRunning: boolean
	}) {
		if (!instances.length) {
			return <box visible={false} />
		}

		const windowCount = instances.length
		const windowText = windowCount === 1 ? 'window' : 'windows'
		const tooltipText = `${appClass} (${windowCount} ${windowText})`

		function handleLeftClick() {
			const focusedClient = hypr.get_focused_client()
			const activeInstance = instances.find(c => c.address === focusedClient?.address)

			if (activeInstance && instances.length > 1) {
				const currentIndex = instances.indexOf(activeInstance)
				const nextInstance = instances[(currentIndex + 1) % instances.length]
				nextInstance.focus()
			} else {
				instances[0].focus()
			}
		}

		function handleRightClick() {
			const focusedClient = hypr.get_focused_client()
			const activeInstance = instances.find(c => c.address === focusedClient?.address)
			const targetInstance = activeInstance || instances[0]

			targetInstance.focus()
			hypr.message("dispatch fullscreen")
		}

		function handleMiddleClick() {
			instances.forEach(client => client.kill())
		}

		function handleClick(self: Gtk.GestureClick) {
			const button = self.get_current_button()

			if (button === BUTTON_PRIMARY) handleLeftClick()
			if (button === BUTTON_SECONDARY) handleRightClick()
			if (button === BUTTON_MIDDLE) handleMiddleClick()

			self.reset()
		}

		return (
			<box class="dock-icon" orientation={Orientation.VERTICAL} halign={Align.CENTER}>
				<button class="app-button" tooltipText={tooltipText}>
					<Gtk.GestureClick button={0} onPressed={handleClick} />
					<image
						halign={Align.CENTER}
						valign={Align.CENTER}
						iconName={appClass}
						pixelSize={64}
						useFallback
					/>
				</button>
				<box
					class="focused"
					visible={isRunning}
					halign={Align.CENTER}
				/>
			</box>
		)
	}

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
			<box class="dock-icon" orientation={Orientation.VERTICAL} halign={Align.CENTER}>
				<button class={buttonClass} tooltipText={appName} onClicked={handleLaunch}>
					<image
						halign={Align.CENTER}
						valign={Align.CENTER}
						iconName={app.get_icon_name()}
						pixelSize={64}
					/>
				</button>
			</box>
		)
	}

	function DockContainer() {
		function renderDockItem(item: typeof mergedDockItems.get[0]) {
			if (item.type === 'running' && item.group) {
				return <RunningAppIcon {...item.group} />
			}

			if (item.type === 'favorite' && item.app) {
				return <FavoriteAppIcon app={item.app} />
			}

			return null
		}

		return (
			<box class="dock-container" orientation={Orientation.HORIZONTAL} halign={Align.CENTER}>
				<For each={mergedDockItems}>
					{renderDockItem}
				</For>
			</box>
		)
	}

	export function Window({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
		return (
			<window
				name="dock"
				layer={Astal.Layer.TOP}
				exclusivity={Astal.Exclusivity.IGNORE}
				anchor={Astal.WindowAnchor.BOTTOM}
				application={app}
				visible={true}
				marginBottom={4}
				gdkmonitor={gdkmonitor}
			>
				<box class="dock" orientation={Orientation.HORIZONTAL} halign={Align.CENTER}>
					<DockContainer />
				</box>
			</window>
		) as Gtk.Window
	}

}
