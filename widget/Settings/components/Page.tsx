import { Node } from "ags"
import { Gtk } from "ags/gtk4"

const { VERTICAL } = Gtk.Orientation

export interface PageProps {
	name: string
	icon: string
	children?: Node | Node[]
}

export type PageWidget = Gtk.Widget & { attr: { name: string, icon: string } }

export default function Page({ name, icon, children = [] }: PageProps): PageWidget {
	return (
		<Gtk.StackPage
			child={
				<Gtk.ScrolledWindow class="page" css="min-height: 300px;">
					<box class="page-content" vexpand orientation={VERTICAL}>
						{children}
					</box>
				</Gtk.ScrolledWindow> as Gtk.ScrolledWindow
			}
			name={name}
			$={self => {
				(self as any).attr = { name, icon }
			}}>
		</Gtk.StackPage>
	) as PageWidget
}
