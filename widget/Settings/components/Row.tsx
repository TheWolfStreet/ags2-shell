import { Gtk } from "astal/gtk3"

import Setter from "./Setter"

import { Opt } from "../../../lib/option"
import icons from "../../../lib/icons"

const { CENTER } = Gtk.Align

export type RowProps<T> = {
	opt: Opt<T>
	title: string
	note?: string
	type?:
	| "number"
	| "color"
	| "float"
	| "object"
	| "string"
	| "enum"
	| "boolean"
	| "img"
	| "font"
	enums?: string[]
	max?: number
	min?: number
}

export interface Row extends Gtk.Widget {
	attr?: { opt: any }
}

export default function Row<T>(props: RowProps<T>): Row {
	const row = (
		<box className="row" tooltipText={props.note ? `note: ${props.note}` : ""}>
			<box vertical valign={CENTER}>
				<label className="row-title" xalign={0} label={props.title} />
				<label className="id" xalign={0} label={props.opt.id} />
			</box>
			<box hexpand />
			<box valign={CENTER}>
				{Setter(props)}
				<box valign={CENTER}>
					<button
						className="reset"
						valign={CENTER}
						onClicked={() => props.opt.reset()}
						sensitive={props.opt((v: T) => v !== props.opt.initial)}
					>
						<icon icon={icons.ui.refresh} useFallback />
					</button>
				</box>
			</box>
		</box>
	) as Row

	row.attr = { opt: props.opt }
	return row
}
