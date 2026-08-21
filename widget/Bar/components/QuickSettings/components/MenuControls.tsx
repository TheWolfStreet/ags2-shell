// Creates expandable Quick Settings rows with animated arrows.

import { Accessor, createState, FCProps, Node, onCleanup } from "ags"
import { Gtk } from "ags/gtk4"
import { timeout, Timer } from "ags/time"

import Pango from "gi://Pango"

import icons from "$lib/icons"
import { isAccessor, readValue } from "$lib/ui"
import { onWindowToggle } from "$lib/windowing"

import options from "$shell/options"

const { SLIDE_DOWN } = Gtk.RevealerTransitionType
const { VERTICAL } = Gtk.Orientation
const { EllipsizeMode } = Pango

const [openedMenuName, setOpenedMenuName] = createState("")

export const quickSettingsSubmenu = {
	opened: openedMenuName,
	open: (name: string) => {
		setOpenedMenuName(name)
	},
	close: () => {
		setOpenedMenuName("")
	},
	toggle: (name: string) => {
		setOpenedMenuName(openedMenuName.peek() === name ? "" : name)
	},
}

export function Menu({ name, iconName, title, headerChild, children }: MenuProps & {
	headerChild?: Node
	children?: Node | Node[]
}) {
	const menuName = () => readValue(name) ?? ""
	const className = isAccessor<string>(name) ? name.as(value => `menu ${value}`) : `menu ${name ?? ""}`

	return (
		<revealer
			transitionType={SLIDE_DOWN}
			transitionDuration={options.transition.duration}
			revealChild={quickSettingsSubmenu.opened.as(opened => opened === menuName())}
			vexpand={false} hexpand={false}
		>
			<box
				class={className}
				orientation={VERTICAL}
			>
				<box class="title-box horizontal">
					<image class="icon" iconName={iconName} useFallback />
					<label class="title" label={title} />
					{headerChild}
				</box>
				<Gtk.Separator />
				<box class="content vertical" orientation={VERTICAL} vexpand hexpand children={children} />
			</box>
		</revealer>
	)
}

export function ToggleButton({
	name,
	iconName,
	label,
	connection,
	toggle,
	activate,
	deactivate,
	activateOnArrow = false,
	arrow = false,
}: FCProps<Gtk.Widget, ToggleButtonProps> & {
	connection?: Accessor<boolean>
	toggle?: () => void
	activate?: () => void
	deactivate?: () => void
	activateOnArrow?: boolean
	arrow?: boolean
}) {
	const arrowRotation = arrow ? useArrowRotation(name) : null

	const onClicked = () => {
		if (toggle) {
			toggle()
		} else if (connection?.peek()) {
			deactivate?.()
			arrowRotation?.closeMenuIfOpen()
		} else {
			activate?.()
		}
	}

	const base = arrow ? "toggle-button" : "simple-toggle"
	const className = connection?.as(v => v ? `${base} active` : base) ?? base

	return (
		<box class={className}>
			<button onClicked={onClicked} tooltipText={label}>
				<box class="horizontal" hexpand>
					<image class="icon" iconName={iconName} useFallback />
					<label class="label" ellipsize={EllipsizeMode.END} maxWidthChars={11} label={label} />
				</box>
			</button>
			{arrow && arrowRotation && (
				<button class="arrow" visible onClicked={() => {
					arrowRotation.toggleMenu()
					if (activateOnArrow) activate?.()
				}}>
					<image iconName={icons.ui.arrow.right} useFallback css={arrowRotation.css} />
				</button>
			)}
		</box>
	)
}

export function Arrow(
	{
		name,
		visible,
		activate = false,
		tooltipText
	}: FCProps<Gtk.Button, ArrowProps>
) {
	const arrowRotation = useArrowRotation(name)

	return (
		<button
			class="arrow"
			visible={visible}
			tooltipText={tooltipText ?? ""}
			onClicked={() => {
				arrowRotation.toggleMenu()
				if (typeof activate === "function") activate()
			}}
		>
			<image iconName={icons.ui.arrow.right} useFallback css={arrowRotation.css} />
		</button>
	)
}

export function SettingsButton({ callback }: { callback: () => void }) {
	return (
		<button onClicked={callback} hexpand>
			<box class="settings horizontal">
				<image iconName={icons.ui.settings} useFallback />
				<label label={"Settings"} />
			</box>
		</button>
	)
}

onWindowToggle("quicksettings", window => {
	if (!window.visible) {
		timeout(1, () => quickSettingsSubmenu.close())
	}
})

function useArrowRotation(name?: Accessor<string> | string) {
	let rotation = 0
	let isOpen = false
	const [css, setCSS] = createState("")
	const animationTimers = new Set<Timer>()

	const menuName = () => readValue(name)

	const animate = (step: number) => {
		for (let i = 0; i < 9; i++) {
			const timer = timeout(options.transition.duration.peek() * 0.075 * i, () => {
				animationTimers.delete(timer)
				rotation += step
				setCSS(`transform: rotate(${rotation}deg);`)
			})
			animationTimers.add(timer)
		}
	}

	const disposeOpened = quickSettingsSubmenu.opened.subscribe(() => {
		const current = menuName()
		if ((quickSettingsSubmenu.opened.peek() === current && !isOpen) || (quickSettingsSubmenu.opened.peek() !== current && isOpen)) {
			animate(quickSettingsSubmenu.opened.peek() === current ? 10 : -10)
			isOpen = !isOpen
		}
	})

	onCleanup(() => {
		disposeOpened()
		for (const timer of animationTimers) timer.cancel()
		animationTimers.clear()
	})

	return {
		css,
		toggleMenu: () => {
			const name = menuName()
			if (name) {
				quickSettingsSubmenu.toggle(name)
			}
		},
		closeMenuIfOpen: () => {
			if (quickSettingsSubmenu.opened.peek() === menuName())
				quickSettingsSubmenu.close()
		},
	}
}

type ArrowProps = {
	name?: string | Accessor<string>
	visible?: boolean | Accessor<boolean>
	tooltipText?: string | Accessor<string>
	activate?: false | (() => void)
}

type ToggleButtonProps = {
	name?: Accessor<string> | string
	iconName?: Accessor<string> | string
	label?: Accessor<string> | string
}

type MenuProps = FCProps<Gtk.Widget, {
	name?: Accessor<string> | string
	iconName?: Accessor<string> | string
	title?: Accessor<string> | string
}>
