import { createComputed, createState } from "ags"
import app from "ags/gtk4/app"
import { Gtk } from "ags/gtk4"

import { createLayout } from "./components/layout"

import { Opt } from "$lib/option"
import icons from "$lib/icons"

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

	function Header(layout: Gtk.StackPage[]) {
		const opts = collectOpts(options)
		const anyChanged = createComputed(
			opts, () => opts.some(opt => opt.get() !== opt.getDefault())
		)

		const [current, set_current] = createState(layout[0].name)

		async function resetAll() {
			const BATCH_SIZE = 8
			for (let i = 0; i < opts.length; i += BATCH_SIZE) {
				const batch = opts.slice(i, i + BATCH_SIZE)
				await Promise.all(batch.map(opt => opt.reset()))
			}
		}

		return {
			current,
			set_current,
			component: (
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
								class={current(v => v === name ? "active" : "")}
								valign={CENTER}
								onClicked={() => set_current(name)}
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
			)
		}
	}

	export function Button() {
		return (
			<button
				valign={CENTER}
				onClicked={() => {
					const settings = app.get_window("settings-dialog")
					const qsettings = app.get_window("quicksettings")
					if (!settings?.visible) {
						settings?.show()
					} else {
						settings.hide()
						settings.show()
					}
					qsettings?.hide()
				}}
			>
				<image iconName={icons.ui.settings} useFallback />
			</button>
		)
	}

	export function Window() {
		const layout = createLayout()
		const header = Header(layout)

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
					{header.component}
					<stack visibleChildName={header.current} transitionType={SLIDE_LEFT_RIGHT}>
						{layout}
					</stack>
				</box>
			</Gtk.Window>
		)
	}
}
