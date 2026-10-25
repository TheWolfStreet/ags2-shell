import assert from "node:assert/strict"
import test from "node:test"
import { load_module } from "../load_module.ts"
import { tick } from "../helpers.ts"

function app(entry, name) {
	return { get_entry: () => entry, get_name: () => name }
}

async function service_fixture(catalog, variants, { failed_watches = 0 } = {}) {
	const commands: unknown[] = []
	const reads: {
		resolve: (value: string) => void
		reject: (error: Error) => void
	}[] = []
	const timeouts: { delay: number; callback: () => void }[] = []
	let on_exit
	const notifications: string[] = []
	const parsed: string[] = []
	let on_catalog_change
	let on_favorites_change
	let on_idle
	const apps = { list: catalog }
	const shutdown_handlers: (() => void)[] = []
	let kills = 0
	const imports = {
		"ags/gobject": {
			default: {
				Object: class {
					notify(property) {
						notifications.push(property)
					}
					vfunc_finalize() {}
				},
			},
			getter: () => () => {},
			register: () => (value) => value,
		},
		"ags/process": {
			execAsync: (args) => {
				commands.push(args)
				return new Promise((resolve, reject) => reads.push({ resolve, reject }))
			},
			Process: class {},
			subprocess: (args, callback) => {
				commands.push(args)
				if (failed_watches-- > 0) throw new Error("dconf missing")
				on_favorites_change = callback
				return {
					connect: (_signal, callback) => {
						on_exit = callback
					},
					kill() {
						kills++
					},
				}
			},
		},
		"$lib/app": {
			default: {
				connect: (signal: string, callback: () => void) => {
					assert.equal(signal, "shutdown")
					shutdown_handlers.push(callback)
				},
			},
		},
		"$lib/time": {
			idle: (callback) => {
				on_idle = callback
				return { cancel() {} }
			},
			timeout: (delay, callback) => {
				timeouts.push({ delay, callback })
				return { cancel() {} }
			},
			debounce: (_delay, callback) => ({ call: callback, cancel() {} }),
		},
		"gi://AstalApps": {
			default: {
				Apps: class {
					get list() {
						return apps.list
					}
				},
			},
		},
		"gi://Gio": {
			default: {
				AppInfoMonitor: {
					get: () => ({
						connect: (_signal, callback) => {
							on_catalog_change = callback
							return 1
						},
						disconnect() {},
					}),
				},
			},
		},
		"gi://GLib": {
			default: {
				VariantType: class {
					constructor(type) {
						assert.equal(type, "as")
					}
				},
				Variant: {
					parse: (_type, raw) => {
						parsed.push(raw)
						if (!variants.has(raw)) throw new Error(`Invalid GVariant: ${raw}`)
						return { get_strv: () => variants.get(raw) }
					},
				},
			},
		},
	}
	const { applications } = await load_module("service/apps.ts", imports)
	return {
		service: applications,
		commands,
		reads,
		notifications,
		parsed,
		async read(raw) {
			assert.ok(reads.length)
			reads.shift()!.resolve(raw)
			await tick()
		},
		async fail(error) {
			reads.shift()!.reject(error)
			await tick()
		},
		exit: (code, signaled) => on_exit({}, code, signaled),
		timeouts,
		watch: () => on_favorites_change(),
		shutdown: () => shutdown_handlers.forEach((handler) => handler()),
		get kills() {
			return kills
		},
		change_catalog(next) {
			apps.list = next
			on_catalog_change()
			on_idle()
		},
	}
}

test("resolves legacy names and extensionless IDs alongside canonical IDs in dconf order", async () => {
	const steam = app("com.valvesoftware.Steam.desktop", "Steam")
	const spotify = app("spotify.desktop", "Spotify")
	const vesktop = app("dev.vencord.Vesktop.desktop", "Vesktop")
	const krita = app("org.kde.krita.desktop", "Krita")
	const blender = app("org.blender.Blender.desktop", "Blender")
	const legacy = "['Steam', 'Spotify', 'Vesktop', 'Krita', 'Blender']"
	const raw =
		"['Steam', 'SPOTIFY.DESKTOP', 'dev.vencord.Vesktop', 'Krita.DESKTOP', 'ORG.BLENDER.BLENDER.DESKTOP', 'missing']"
	const fixture = await service_fixture(
		[blender, krita, vesktop, spotify, steam],
		new Map([
			[legacy, ["Steam", "Spotify", "Vesktop", "Krita", "Blender"]],
			[
				raw,
				[
					"Steam",
					"SPOTIFY.DESKTOP",
					"dev.vencord.Vesktop",
					"Krita.DESKTOP",
					"ORG.BLENDER.BLENDER.DESKTOP",
					"missing",
				],
			],
		]),
	)
	assert.deepEqual(fixture.service.favorites, [])
	assert.equal(fixture.service.list.length, 5)
	await fixture.read(legacy)
	assert.deepEqual(fixture.service.favorites, [
		steam,
		spotify,
		vesktop,
		krita,
		blender,
	])
	fixture.watch()
	await fixture.read(raw)
	assert.deepEqual(fixture.service.favorites, [
		steam,
		spotify,
		vesktop,
		krita,
		blender,
	])
	assert.deepEqual(fixture.notifications, ["favorites", "favorites"])
	const before = fixture.commands.length
	assert.equal(fixture.service.favorites, fixture.service.favorites)
	assert.equal(fixture.commands.length, before)
	assert.deepEqual(fixture.commands, [
		["dconf", "watch", "/org/gnome/shell/favorite-apps"],
		["dconf", "read", "/org/gnome/shell/favorite-apps"],
		["dconf", "read", "/org/gnome/shell/favorite-apps"],
	])
})

test("prefers full IDs, then extensionless IDs, then exact names without fuzzy fallback", async () => {
	const full = app("Steam.desktop", "Other")
	const short = app("Other.desktop", "Steam.desktop")
	const named = app("third.desktop", "Other")
	const first_name = app("first.desktop", "Paint")
	const second_name = app("second.desktop", "Paint")
	const raw =
		"['Steam.desktop', 'Other', 'Paint', 'Pai', 'STEAM', 'Other.desktop']"
	const fixture = await service_fixture(
		[full, short, named, first_name, second_name],
		new Map([
			[
				raw,
				["Steam.desktop", "Other", "Paint", "Pai", "STEAM", "Other.desktop"],
			],
		]),
	)
	await fixture.read(raw)
	assert.deepEqual(fixture.service.favorites, [full, short, first_name])
})

test("deduplicates aliases and uses the first catalog match for colliding IDs", async () => {
	const first = app("foo.desktop", "Foo")
	const second = app("FOO.DESKTOP", "Alternate")
	const raw = "['foo', 'FOO.DESKTOP', 'Alternate', 'Foo', 'foo.desktop']"
	const fixture = await service_fixture(
		[first, second],
		new Map([[raw, ["foo", "FOO.DESKTOP", "Alternate", "Foo", "foo.desktop"]]]),
	)
	await fixture.read(raw)
	assert.deepEqual(fixture.service.favorites, [first])
})

test("remaps the last valid snapshot when the catalog changes", async () => {
	const old_app = app("foo.desktop", "Foo")
	const new_app = app("foo.desktop", "Foo")
	const added = app("bar.desktop", "Bar")
	const raw = "['Foo', 'Bar']"
	const fixture = await service_fixture(
		[old_app],
		new Map([[raw, ["Foo", "Bar"]]]),
	)
	await fixture.read(raw)
	assert.deepEqual(fixture.service.favorites, [old_app])
	fixture.change_catalog([new_app, added])
	assert.deepEqual(fixture.service.favorites, [new_app, added])
	assert.deepEqual(fixture.notifications, ["favorites", "favorites", "list"])
	assert.equal(fixture.commands.length, 2)
})

test("parses empty defaults, typed empty arrays, and escaped strings via GVariant", async () => {
	const quoted = app("quoted.desktop", "It's Krita")
	const raw = '["It\'s Krita"]'
	const fixture = await service_fixture(
		[quoted],
		new Map([
			["[]", []],
			["@as []", []],
			[raw, ["It's Krita"]],
		]),
	)
	await fixture.read("")
	fixture.watch()
	await fixture.read("@as []")
	fixture.watch()
	await fixture.read(raw)
	assert.deepEqual(fixture.parsed, ["[]", "@as []", raw])
	assert.deepEqual(fixture.service.favorites, [quoted])
})

test("invalid GVariant leaves favorites and snapshot intact and can be retried", async () => {
	const old_app = app("foo.desktop", "Foo")
	const new_app = app("bar.desktop", "Bar")
	const valid = "['Foo']"
	const invalid = "['Bar'"
	const variants = new Map([[valid, ["Foo"]]])
	const fixture = await service_fixture([old_app, new_app], variants)
	await fixture.read(valid)
	const errors: string[][] = []
	const original_error = console.error
	console.error = (...args) => errors.push(args)
	try {
		fixture.watch()
		await fixture.read(invalid)
	} finally {
		console.error = original_error
	}
	assert.equal(errors.length, 1)
	assert.match(errors[0][0], /Failed to read favorite apps/)
	assert.deepEqual(fixture.service.favorites, [old_app])
	fixture.change_catalog([app("foo.desktop", "Foo"), new_app])
	assert.equal(fixture.service.favorites[0].get_entry(), "foo.desktop")
	assert.equal(fixture.parsed.at(-1), valid)
	variants.set(invalid, ["Bar"])
	fixture.watch()
	await fixture.read(invalid)
	assert.deepEqual(fixture.service.favorites, [new_app])
	assert.deepEqual(fixture.parsed, [valid, invalid, valid, invalid])
})

test("shell shutdown kills the dconf watch exactly once", async () => {
	const fixture = await service_fixture([], [])
	assert.equal(fixture.kills, 0)
	fixture.shutdown()
	assert.equal(fixture.kills, 1)
	fixture.shutdown()
	assert.equal(fixture.kills, 1)
})

async function capture_errors(run: () => Promise<void> | void) {
	const errors: unknown[][] = []
	const original_error = console.error
	console.error = (...args) => errors.push(args)
	try {
		await run()
	} finally {
		console.error = original_error
	}
	return errors
}

test("a failed favorites read is logged and keeps the previous favorites", async () => {
	const kept = app("foo.desktop", "Foo")
	const raw = "['Foo']"
	const fixture = await service_fixture([kept], new Map([[raw, ["Foo"]]]))
	await fixture.read(raw)
	const failure = new Error("dconf failed")
	const errors = await capture_errors(async () => {
		fixture.watch()
		await fixture.fail(failure)
	})
	assert.deepEqual(errors, [
		["applications.refresh_favorites: Failed to read favorites", failure],
	])
	assert.deepEqual(fixture.service.favorites, [kept])
})

test("a stale favorites read is ignored once a newer read started", async () => {
	const first = app("foo.desktop", "Foo")
	const second = app("bar.desktop", "Bar")
	const fixture = await service_fixture(
		[first, second],
		new Map([
			["['Foo']", ["Foo"]],
			["['Bar']", ["Bar"]],
		]),
	)
	fixture.watch()
	const [stale, fresh] = fixture.reads.splice(0)
	fresh.resolve("['Bar']")
	stale.resolve("['Foo']")
	await tick()
	assert.deepEqual(fixture.service.favorites, [second])
	assert.deepEqual(fixture.notifications, ["favorites"])
})

test("a watch that cannot start or exits is logged and retried with backoff", async () => {
	let fixture
	const errors = await capture_errors(async () => {
		fixture = await service_fixture([], new Map(), { failed_watches: 1 })
	})
	assert.equal(errors.length, 1)
	assert.equal(errors[0][0], "applications.favorites_watch:")
	assert.equal((errors[0][1] as Error).message, "dconf missing")
	assert.deepEqual(
		fixture.timeouts.map((timer) => timer.delay),
		[5000],
	)
	fixture.timeouts[0].callback()
	assert.equal(fixture.commands.filter((args) => args[1] === "watch").length, 2)
	assert.equal(fixture.commands.filter((args) => args[1] === "read").length, 2)
	const exited = await capture_errors(() => fixture.exit(1, false))
	assert.deepEqual(exited, [
		["applications.favorites_watch: Dconf watch exited with status 1"],
	])
	const signaled = await capture_errors(() => fixture.exit(9, true))
	assert.deepEqual(signaled, [
		["applications.favorites_watch: Dconf watch exited with signal 9"],
	])
	assert.deepEqual(
		fixture.timeouts.map((timer) => timer.delay),
		[5000, 15000],
	)
	fixture.shutdown()
	assert.deepEqual(await capture_errors(() => fixture.exit(1, false)), [])
})
