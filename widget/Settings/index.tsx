import { Variable } from "astal"
import { App, Gtk } from "astal/gtk3"

import { RegularWindow } from "../RegularWindow"

import { Opt } from "../../lib/option"
import layout from "./components/layout"
import icons from "../../lib/icons"
import { checkDefault } from "../../lib/utils"
import options from "../../options"

const current = Variable(layout[0].attr.name)
const { START, END } = Gtk.Align
const { SLIDE_LEFT_RIGHT } = Gtk.StackTransitionType

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

const Header = () => {
	return <centerbox className="header">
		<button
			className="reset"
			onClicked={options.reset}
			sensitive={checkDefault(collectOpts(options))}
			halign={START}
			valign={START}
			tooltipText="Reset"
		>
			<icon icon={icons.ui.refresh} useFallback />
		</button>

		<box className="pager horizontal">
			{layout.map(({ attr: { name, icon } }) => (
				<button
					halign={0}
					className={current(v => v === name ? "active" : "")}
					onClicked={() => current.set(name)}
				>
					<box>
						<icon icon={icon} useFallback />
						<label label={name} />
					</box>
				</button>
			))}
		</box>
		<button
			className="close"
			halign={END}
			valign={START}
			onClick={() => App.get_window("settings-dialog")?.close()}
		>
			<icon icon={icons.ui.close} useFallback />
		</button>
	</centerbox>
}

export default () =>
	<RegularWindow name="settings-dialog"
		className="settings-dialog"
		title="Settings"
		defaultHeight={600}
		defaultWidth={500}
		visible={false}
		onDeleteEvent={(w => {
			w.hide()
			return true
		})}
	>
		<box vertical>
			{Header()}
			<stack transitionType={SLIDE_LEFT_RIGHT} shown={current() as never}>
				{layout}
			</stack>
		</box>
	</RegularWindow>
