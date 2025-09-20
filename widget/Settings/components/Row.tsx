import { Gtk } from "ags/gtk4"
import { FCProps, Node } from "ags"
import Setter from "./Setter"
import icons from "$lib/icons"
import { Opt } from "$lib/option"

const { CENTER } = Gtk.Align
const { VERTICAL } = Gtk.Orientation

export type RowProps = FCProps<
	Gtk.Box,
	{
		opt: Opt<any>
		title?: string
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
>

export function Row({
	opt,
	title,
	note,
	type,
	enums,
	max,
	min,
}: RowProps) {
	return (
		<box
			class="row"
			tooltipText={note ? `${note}` : ""}
			$={(self) => { (self as any).opt = opt }}
		>
			<box orientation={VERTICAL} valign={CENTER}>
				<label class="row-title" xalign={0} label={title} />
				<label class="id" xalign={0} label={opt.id} />
			</box>

			<box hexpand />

			<box valign={CENTER}>
				<Setter
					opt={opt}
					type={type}
					enums={enums}
					max={max}
					min={min}
				/>
				<box valign={CENTER}>
					<button
						class="reset"
						valign={CENTER}
						onClicked={() => opt.reset()}
						sensitive={opt.as(
							(v) => v !== opt.getDefault(),
						)}
					>
						<image iconName={icons.ui.refresh} useFallback />
					</button>
				</box>
			</box>
		</box>
	)
}
