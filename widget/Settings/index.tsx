import { createComputed, createState } from "ags"
import app from "ags/gtk4/app"
import { Gtk } from "ags/gtk4"

import { Opt } from "$lib/option"
import icons from "$lib/icons"

import { layout } from "./components/layout"

import options from "options"

const [current, set_current] = createState(layout[0].attr.name)

const { SLIDE_LEFT_RIGHT } = Gtk.StackTransitionType
const { CENTER } = Gtk.Align
const { VERTICAL } = Gtk.Orientation

export namespace Settings {
	function collectOpts(obj: { [x: string]: any }) {
		let opts: any[] = []
		for (let key in obj) {
			const value = obj[key]

			if (value && typeof value === 'object') {
				opts = opts.concat(collectOpts(value))
			} else if (value instanceof Opt) {
				opts.push(value)
			}
		}
		return opts
	}

	function Header() {
		const opts = collectOpts(options)
		const anyChanged = createComputed(
			opts, () => {
				for (const opt of opts) {
					if (opt.get() !== opt.getDefault()) return true
				}
				return false
			}
		)

		return (
			<centerbox class="header" >
				<button $type="start"
					class="reset"
					onClicked={() => { opts.forEach((o) => o.reset()) }}
					sensitive={anyChanged}
					tooltipText="Reset"
					valign={CENTER}
				>
					<image iconName={icons.ui.refresh} useFallback />
				</button>

				< box class="pager horizontal" $type="center" >
					{
						layout.map(({ attr: { name, icon } }) => (
							<button
								halign={0}
								class={current(v => v === name ? "active" : "")
								}
								onClicked={() => set_current(name)}
								valign={CENTER}
							>
								<box>
									<image iconName={icon} useFallback />
									<label label={name} />
								</box>
							</button>
						))}
				</box>
				< button
					class="close"
					$type="end"
					onClicked={() => app.get_window("settings-dialog")?.close()}
					valign={CENTER}
				>
					<image iconName={icons.ui.close} useFallback />
				</button>
			</centerbox>
		)
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
					<Header />
					< stack visibleChildName={current} transitionType={SLIDE_LEFT_RIGHT}>
						{layout}
					</stack>
				</box>
			</Gtk.Window>)
	}

}
