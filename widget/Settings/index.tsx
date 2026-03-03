import { createComputed, createState } from "ags"
import app from "ags/gtk4/app"
import { Gtk } from "ags/gtk4"

import { createLayout } from "./components/layout"

import { Opt } from "$lib/option"
import icons from "$lib/icons"
import { hypr } from "$lib/services"

import options from "options"

const { SLIDE_LEFT_RIGHT } = Gtk.StackTransitionType
const { CENTER } = Gtk.Align
const { VERTICAL } = Gtk.Orientation

export namespace Settings {

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

	export function Button() {
		return (
			<button
				valign={CENTER}
				onClicked={() => {
					const settings = app.get_window("settings-dialog")
					const qsettings = app.get_window("quicksettings")
					qsettings?.hide()

					if (settings?.visible) {
						const workspace = hypr.focusedWorkspace?.id
						if (workspace != null)
							hypr.dispatch("movetoworkspace", `${workspace},title:^(Settings)$`)
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
		const layout = createLayout()
		const allOpts = collectOpts(options)

		let stack: Gtk.Stack | undefined
		const [currentPage, setCurrentPage] = createState(layout[0].name)

		const anyChanged = createComputed(() => allOpts.some(opt => opt() !== opt.getDefault()))

		function resetAll() {
			allOpts.forEach(opt => opt.reset())
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
				defaultHeight={600}
				defaultWidth={500}
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
							{layout.map(({ name, iconName }) => (
								<button
									class={currentPage.as(v => v === name ? `active` : "")}
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
						{layout}
					</stack>
				</box>
			</Gtk.Window>
		)
	}
}
