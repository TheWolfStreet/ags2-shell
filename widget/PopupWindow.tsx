import { Widget, Gtk, Gdk, App, Astal } from "astal/gtk3"
import { Binding, timeout, Variable } from "astal"
import options from "../options"
import { onWindowToggle, toggleWindow } from "../lib/utils"

const Padding = ({ name, css = "", hexpand = true, vexpand = true }: { name: string, css?: string, hexpand?: boolean, vexpand?: boolean }) =>
	<eventbox
		hexpand={hexpand}
		vexpand={vexpand}
		canFocus={false}
		onButtonPressEvent={() => toggleWindow(name)}
	>
		<box css={css} />
	</eventbox >

const PopupRevealer = ({ reveal, child, transitionType: transitionType = Gtk.RevealerTransitionType.SLIDE_DOWN }: { reveal: boolean | Binding<boolean>, child: any, transitionType?: Gtk.RevealerTransitionType | Binding<Gtk.RevealerTransitionType> }) =>
	<box css="padding: 1px;">
		<revealer revealChild={reveal} transitionType={transitionType} transitionDuration={options.transition()}>
			<box className="window-content" child={child} />
		</revealer>
	</box >

export type Position = 'center' | 'top' | 'top-right' | 'top-center' | 'top-left' |
	'bottom-left' | 'bottom-center' | 'bottom-right'

interface LayoutProps {
	name: string
	child: any
	revealChild: boolean | Binding<boolean>
	transitionType?: Gtk.RevealerTransitionType | Binding<Gtk.RevealerTransitionType>
	layout: Position
}

function Layout({ name, child, revealChild: reveal, transitionType: transitionType, layout }: LayoutProps) {
	const render = (position: Position) => {
		switch (position) {
			case 'center':
				return (
					<centerbox>
						<Padding name={name} />
						<centerbox vertical>
							<Padding name={name} />
							<PopupRevealer reveal={reveal} child={child} transitionType={transitionType} />
							<Padding name={name} />
						</centerbox>
						<Padding name={name} />
					</centerbox>
				)

			case 'top':
				return (
					<centerbox>
						<Padding name={name} />
						<box vertical>
							<PopupRevealer reveal={reveal} child={child} transitionType={transitionType} />
							<Padding name={name} />
						</box>
						<Padding name={name} />
					</centerbox>
				)

			case 'top-right':
				return (
					<box>
						<Padding name={name} />
						<box hexpand={false} vertical>
							<PopupRevealer reveal={reveal} child={child} transitionType={transitionType} />
							<Padding name={name} />
						</box>
					</box>
				)

			case 'top-center':
				return (
					<box>
						<Padding name={name} />
						<box hexpand={false} vertical>
							<PopupRevealer reveal={reveal} child={child} transitionType={transitionType} />
							<Padding name={name} />
						</box>
						<Padding name={name} />
					</box>
				)

			case 'top-left':
				return (
					<box>
						<box hexpand={false} vertical>
							<PopupRevealer reveal={reveal} child={child} transitionType={transitionType} />
							<Padding name={name} />
						</box>
						<Padding name={name} />
					</box>
				)

			case 'bottom-left':
				return (
					<box>
						<box hexpand={false} vertical>
							<Padding name={name} />
							<PopupRevealer reveal={reveal} child={child} transitionType={transitionType} />
						</box>
						<Padding name={name} />
					</box>
				)

			case 'bottom-center':
				return (
					<box>
						<Padding name={name} />
						<box hexpand={false} vertical>
							<Padding name={name} />
							<PopupRevealer reveal={reveal} child={child} transitionType={transitionType} />
						</box>
						<Padding name={name} />
					</box>
				)

			case 'bottom-right':
				return (
					<box>
						<Padding name={name} />
						<box hexpand={false} vertical>
							<Padding name={name} />
							<PopupRevealer reveal={reveal} child={child} transitionType={transitionType} />
						</box>
					</box>
				)

			default:
				throw new Error(`Unknown layout: ${position}`)
		}
	}
	return (
		<box
			child={render(layout)}
		/>
	)
}

type PopupWindowProps = Omit<Widget.WindowProps, "name"> & {
	name: string
	layout?: Position
	transitionType?: Gtk.RevealerTransitionType | Binding<Gtk.RevealerTransitionType>
}

export default ({
	name,
	child,
	layout = "center",
	layer = Astal.Layer.TOP,
	transitionType: transitionType,
	exclusivity = Astal.Exclusivity.IGNORE,
	...props
}: PopupWindowProps) => {
	const { TOP, BOTTOM, LEFT, RIGHT } = Astal.WindowAnchor
	const reveal = Variable(false)

	return (
		<window
			name={name}
			className={`${name} popup-window`}
			application={props.application || App}
			onKeyPressEvent={(self, event: Gdk.Event) => {
				if (event.get_keyval()[1] === Gdk.KEY_Escape) {
					self.close()
				}
			}}
			visible={false}
			onDeleteEvent={self => {
				reveal.set(false)
				timeout(options.transition.get(), () => {
					self.hide_on_delete()
				})
				return true
			}}
			setup={self => {
				onWindowToggle(self, name, (w) => {
					if (w.visible) {
						reveal.set(true)
					} else {
						reveal.set(false)
					}
				})
			}}
			keymode={Astal.Keymode.ON_DEMAND}
			exclusivity={exclusivity}
			layer={layer}
			anchor={TOP | BOTTOM | RIGHT | LEFT}
			{...props}
		>
			<Layout name={name} revealChild={reveal()} child={child} transitionType={transitionType} layout={layout} />
		</window>
	)
}
