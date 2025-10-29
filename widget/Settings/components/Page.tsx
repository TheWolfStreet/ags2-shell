import { FCProps } from "ags"
import { Gtk } from "ags/gtk4"

const { VERTICAL } = Gtk.Orientation

export const Page = ({ name, iconName, children = [] }: FCProps<Gtk.StackPage, {
	name: string,
	iconName: string,
	children?: JSX.Element | Array<JSX.Element>
}>) => (
	<Gtk.StackPage
		name={name}
		iconName={iconName}
		child={
			<Gtk.ScrolledWindow class="page" css="min-height: 300px;">
				<box class="page-content" vexpand orientation={VERTICAL}>
					{children}
				</box>
			</Gtk.ScrolledWindow> as Gtk.ScrolledWindow
		}
	/>
)
