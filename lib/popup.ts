// Finds where to place a popup beside the bar.

import { Accessor, createComputed } from "ags"

type Vertical = "top" | "center" | "bottom"
type Horizontal = "left" | "center" | "right"
export type Position =
	| `${Vertical}-${Horizontal}`
	| "center"

export function popupLayout(bar: Accessor<string>, popup: Accessor<string>): Accessor<Position> {
	return createComputed(() => {
		const vertical = bar().split("-")[0]
		const horizontal = popup().split("-").pop() ?? "center"
		return `${vertical}-${horizontal}` as Position
	})
}
