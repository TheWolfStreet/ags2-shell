// Shows the Settings window and switches between editable pages.

import { createComputed, createRoot, createState } from "ags"
import app from "ags/gtk4/app"
import { Gtk } from "ags/gtk4"

import { createPages } from "./components/Pages"

import icons from "$lib/icons"
import { hyprland } from "$lib/hyprland"

import options, { Opt } from "$shell/options"

export namespace Settings {
	export function Button() {
		return (
			<button
				valign={CENTER}
				onClicked={() => {
					const settings = ensureWindow()
					const qsettings = app.get_window("quicksettings")
					qsettings?.hide()

					if (settings?.visible) {
						const workspace = hyprland.focusedWorkspace?.id
						if (workspace != null)
							hyprland.dispatch(
								"movetoworkspace",
								`${workspace},title:^(Settings)$`,
							)
					} else {
						settings?.show()
					}
				}}
			>
				<image iconName={icons.ui.settings} useFallback />
			</button>
		)
	}

	export function Window() {
		const existing = app.get_window("settings-dialog")
		if (existing) return existing
		const pages = createPages()
		const allOpts = collectOpts(options)

		let stack: Gtk.Stack | undefined
		const [currentPage, setCurrentPage] = createState(pages[0].name)

		const anyChanged = createComputed(() =>
			allOpts.some((opt) => opt() !== opt.getDefault()),
		)

		function resetAll() {
			allOpts.forEach((opt) => opt.reset())
		}

		function setup(self: Gtk.Stack) {
			stack = self
			const name = currentPage.peek()
			if (self.get_child_by_name(name)) {
				self.set_visible_child_name(name)
			}
		}

		return (
			<Gtk.Window
				title="Settings"
				name="settings-dialog"
				class="settings-dialog"
				application={app}
				defaultHeight={options.scale.as((scale) =>
					Math.round((600 * scale) / 100),
				)}
				defaultWidth={options.scale.as((scale) =>
					Math.round((500 * scale) / 100),
				)}
				hideOnClose
				iconName={icons.ui.settings}
			>
				<box orientation={VERTICAL}>
					<centerbox class="header">
						<button
							class="reset"
							$type="start"
							valign={CENTER}
							sensitive={anyChanged}
							tooltipText="Reset"
							onClicked={resetAll}
						>
							<image iconName={icons.ui.refresh} useFallback />
						</button>

						<box class="pager horizontal" $type="center">
							{pages.map(({ name, iconName }) => (
								<button
									class={currentPage.as((v) => (v === name ? `active` : ""))}
									valign={CENTER}
									onClicked={() => {
										setCurrentPage(name)
										stack?.set_visible_child_name(name)
									}}
								>
									<box>
										<image iconName={iconName} useFallback />
										<label label={name} />
									</box>
								</button>
							))}
						</box>

						<button
							class="close"
							$type="end"
							valign={CENTER}
							onClicked={() => app.get_window("settings-dialog")?.close()}
						>
							<image iconName={icons.ui.close} useFallback />
						</button>
					</centerbox>

					<stack transitionType={SLIDE_LEFT_RIGHT} $={setup}>
						{pages}
					</stack>
				</box>
			</Gtk.Window>
		)
	}

	const { SLIDE_LEFT_RIGHT } = Gtk.StackTransitionType
	const { CENTER } = Gtk.Align
	const { VERTICAL } = Gtk.Orientation

	let root: (() => void) | null = null

	function ensureWindow() {
		const existing = app.get_window("settings-dialog")
		if (existing) return existing

		let window: Gtk.Window | null = null
		root ??= createRoot((dispose) => {
			window = Settings.Window() as Gtk.Window
			return dispose
		})
		return window
	}

	function collectOpts(obj: Record<string, unknown>): Opt<any>[] {
		let opts: Opt<any>[] = []
		for (const key in obj) {
			const value = obj[key]
			if (value instanceof Opt) {
				opts.push(value)
			} else if (value && typeof value === "object") {
				opts = opts.concat(collectOpts(value as Record<string, unknown>))
			}
		}
		return opts
	}
}
