import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import { accessor, jsx_runtime, make, nodes } from "../helpers.ts"

function player(bus_name: string, status = 2) {
	const handlers = new Map<number, () => void>()
	const calls: string[] = []
	return {
		calls,
		handlers,
		title: "",
		artist: "",
		entry: "",
		get_bus_name: () => bus_name,
		get_title() {
			return this.title
		},
		get_playback_status: () => status,
		pause: () => calls.push("pause"),
		play: () => calls.push("play"),
		connect(_signal: string, fn: () => void) {
			const id = handlers.size + 1
			handlers.set(id, fn)
			return id
		},
		disconnect: (id: number) => handlers.delete(id),
	}
}

async function media_fixture(players, preferred = "") {
	const timers: { ms: number; fn: () => void; cancelled: boolean }[] = []
	const cleanups: (() => void)[] = []
	let reveal = false
	const module = await load_module(
		"widget/Bar/components/Buttons/MediaIndicator.tsx",
		{
			ags: {
				createBinding: (object, property) => accessor(() => object[property]),
				createComputed: (fn) => accessor(fn),
				createState: (initial) => {
					reveal = initial
					return [
						accessor(() => reveal),
						(next) => {
							reveal = next
						},
					]
				},
				onCleanup: (fn) => cleanups.push(fn),
				With: ({ value, children }) => children(value()),
			},
			"ags/gtk4": {
				Gtk: {
					Align: { CENTER: 3 },
					RevealerTransitionType: { SLIDE_LEFT: 4 },
					EventControllerMotion: "motion",
				},
			},
			"ags/gtk4/jsx-runtime": jsx_runtime,
			"$lib/time": {
				timeout: (ms, fn) => {
					const timer = { ms, fn, cancelled: false }
					timers.push(timer)
					return {
						cancel: () => {
							timer.cancelled = true
						},
					}
				},
			},
			"gi://AstalMpris": {
				default: {
					get_default: () => ({ players }),
					PlaybackStatus: { PLAYING: 0 },
				},
			},
			"gi://Pango": { default: { EllipsizeMode: { END: 3 } } },
			"$shell/options": {
				default: {
					bar: { media: { preferred: () => preferred } },
					notifications: { dismiss: { peek: () => 3000 } },
				},
			},
			"../PanelButton": { PanelButton: (props) => make("panel", props) },
			"$lib/icons": { default: { fallback: { audio: "audio" } } },
		},
	)
	const root = module.MediaIndicator()
	const button = nodes(root, "panel")[0]
	const revealer = nodes(root, "revealer")[0]
	const self = { destroyed: false, in_destruction: () => self.destroyed }
	revealer?.props.$(self)
	return {
		root,
		button,
		revealer,
		self,
		timers,
		cleanups,
		motion: nodes(root, "motion")[0],
		label: nodes(root, "label")[0],
		image: nodes(root, "image")[0],
		reveal: () => reveal,
	}
}

test("no player hides the indicator", async () => {
	const f = await media_fixture([])
	assert.equal(f.root.props.visible(), false)
	assert.equal(f.button, undefined)
})

test("the preferred player is chosen and a click toggles its playback", async () => {
	const spotify = player("org.mpris.MediaPlayer2.spotify", 0)
	const other = player("org.mpris.MediaPlayer2.firefox", 2)
	const f = await media_fixture([other, spotify], "spotify")
	assert.equal(f.root.props.visible(), true)
	f.button.props.onClicked()
	assert.deepEqual(spotify.calls, ["pause"])
	const paused = await media_fixture([other])
	paused.button.props.onClicked()
	assert.deepEqual(other.calls, ["play"])
})

test("the label shows artist and title with fallbacks", async () => {
	const current = player("a")
	const f = await media_fixture([current])
	assert.equal(f.label.props.label(), "Untitled")
	current.title = "Song"
	assert.equal(f.label.props.label(), "Song")
	current.artist = "Band"
	assert.equal(f.label.props.label(), "Band - Song")
	assert.equal(f.image.props.iconName(), "audio")
	current.entry = "spotify"
	assert.equal(f.image.props.iconName(), "spotify")
})

test("a new title reveals briefly, hovering keeps it open and cleanup resets", async () => {
	const current = player("a")
	const f = await media_fixture([current])
	const [notify_title] = current.handlers.values()
	current.title = "One"
	notify_title()
	assert.equal(f.reveal(), true)
	assert.equal(f.timers.length, 1)
	assert.equal(f.timers[0].ms, 3000)
	notify_title()
	assert.equal(f.timers.length, 1)
	current.title = "Two"
	notify_title()
	assert.equal(f.timers[0].cancelled, true)
	f.timers[1].fn()
	assert.equal(f.reveal(), false)

	current.title = "Three"
	notify_title()
	f.motion.props.onEnter()
	assert.equal(f.timers[2].cancelled, true)
	assert.equal(f.reveal(), true)
	f.motion.props.onLeave()
	assert.equal(f.reveal(), false)

	current.title = "Four"
	notify_title()
	f.self.destroyed = true
	f.timers[3].fn()
	assert.equal(f.reveal(), true)

	current.title = "Five"
	notify_title()
	for (const cleanup of f.cleanups) cleanup()
	assert.equal(current.handlers.size, 0)
	assert.equal(f.timers[4].cancelled, true)
	assert.equal(f.reveal(), false)
})
