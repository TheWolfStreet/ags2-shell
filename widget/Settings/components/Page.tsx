import { Gtk } from "astal/gtk3"

import Group from "./Group"

export interface Page extends Gtk.Widget {
	attr: { name: string, icon: string }
}

export default function <T>(name: string, icon: string, ...groups: ReturnType<typeof Group<T>>[]): Page {
	const page = <box className="page" name={name}>
		<scrollable css="min-height: 300px;">
			<box className="page-content" vexpand vertical>
				{groups}
			</box>
		</scrollable>
	</box> as Page

	page.attr = { name, icon }
	return page
}
