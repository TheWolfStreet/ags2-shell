import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { SourceTextModule, SyntheticModule } from "node:vm"

const tsc_path = realpathSync(execFileSync("which", ["tsc"], { encoding: "utf8" }).trim())
const ts = createRequire(tsc_path)("../lib/node_modules/typescript/lib/typescript.js")

const app = (entry, name) => ({ get_entry: () => entry, get_name: () => name })

async function service_fixture(catalog, variants) {
	const commands = []
	const reads = []
	const notifications = []
	const parsed = []
	let on_catalog_change
	let on_favorites_change
	let on_idle
	const apps = { list: catalog }
	const imports = {
		"ags/gobject": {
			default: { Object: class { notify(property) { notifications.push(property) } vfunc_finalize() {} } },
			getter: () => () => {}, register: () => value => value,
		},
		"ags/process": {
			execAsync: args => {
				commands.push(args)
				return new Promise(resolve => reads.push(resolve))
			},
			Process: class {},
			subprocess: (args, callback) => {
				commands.push(args)
				on_favorites_change = callback
				return { connect() {}, kill() {} }
			},
		},
		"$lib/time": {
			idle: callback => { on_idle = callback; return { cancel() {} } },
			timeout: () => ({ cancel() {} }),
			debounce: (_delay, callback) => ({ call: callback, cancel() {} }),
		},
		"gi://AstalApps": { default: { Apps: class { get list() { return apps.list } } } },
		"gi://Gio": { default: { AppInfoMonitor: { get: () => ({
			connect: (_signal, callback) => { on_catalog_change = callback; return 1 },
			disconnect() {},
		}) } } },
		"gi://GLib": { default: {
			VariantType: class { constructor(type) { assert.equal(type, "as") } },
			Variant: { parse: (_type, raw) => {
				parsed.push(raw)
				if (!variants.has(raw)) throw new Error(`Invalid GVariant: ${raw}`)
				return { get_strv: () => variants.get(raw) }
			} },
		} },
		"$lib/result": { attempt: fn => {
			try { return { ok: true, value: fn() } }
			catch (err) { return { ok: false, err } }
		} },
	}
	const source = readFileSync(new URL("../../service/apps.ts", import.meta.url), "utf8")
	const compiled = ts.transpileModule(source, { compilerOptions: {
		module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
		experimentalDecorators: true,
	} }).outputText
	const module = new SourceTextModule(compiled)
	await module.link(name => {
		assert.ok(imports[name], name)
		return new SyntheticModule(Object.keys(imports[name]), function () {
			for (const [key, value] of Object.entries(imports[name])) this.setExport(key, value)
		})
	})
	await module.evaluate()
	return {
		service: module.namespace.applications, commands, reads, notifications, parsed,
		async read(raw) {
			assert.ok(reads.length)
			reads.shift()(raw)
			await Promise.resolve()
		},
		watch: () => on_favorites_change(),
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
	const raw = "['Steam', 'SPOTIFY.DESKTOP', 'dev.vencord.Vesktop', 'Krita.DESKTOP', 'ORG.BLENDER.BLENDER.DESKTOP', 'missing']"
	const fixture = await service_fixture([blender, krita, vesktop, spotify, steam], new Map([
		[legacy, ["Steam", "Spotify", "Vesktop", "Krita", "Blender"]],
		[raw, [
		"Steam", "SPOTIFY.DESKTOP", "dev.vencord.Vesktop", "Krita.DESKTOP", "ORG.BLENDER.BLENDER.DESKTOP", "missing",
		]],
	]))
	assert.deepEqual(fixture.service.favorites, [])
	assert.equal(fixture.service.list.length, 5)
	await fixture.read(legacy)
	assert.deepEqual(fixture.service.favorites, [steam, spotify, vesktop, krita, blender])
	fixture.watch()
	await fixture.read(raw)
	assert.deepEqual(fixture.service.favorites, [steam, spotify, vesktop, krita, blender])
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
	const raw = "['Steam.desktop', 'Other', 'Paint', 'Pai', 'STEAM', 'Other.desktop']"
	const fixture = await service_fixture([full, short, named, first_name, second_name], new Map([[raw, [
		"Steam.desktop", "Other", "Paint", "Pai", "STEAM", "Other.desktop",
	]]]))
	await fixture.read(raw)
	assert.deepEqual(fixture.service.favorites, [full, short, first_name])
})

test("deduplicates aliases and uses the first catalog match for colliding IDs", async () => {
	const first = app("foo.desktop", "Foo")
	const second = app("FOO.DESKTOP", "Alternate")
	const raw = "['foo', 'FOO.DESKTOP', 'Alternate', 'Foo', 'foo.desktop']"
	const fixture = await service_fixture([first, second], new Map([[raw, ["foo", "FOO.DESKTOP", "Alternate", "Foo", "foo.desktop"]]]))
	await fixture.read(raw)
	assert.deepEqual(fixture.service.favorites, [first])
})

test("remaps the last valid snapshot when the catalog changes", async () => {
	const old_app = app("foo.desktop", "Foo")
	const new_app = app("foo.desktop", "Foo")
	const added = app("bar.desktop", "Bar")
	const raw = "['Foo', 'Bar']"
	const fixture = await service_fixture([old_app], new Map([[raw, ["Foo", "Bar"]]]))
	await fixture.read(raw)
	assert.deepEqual(fixture.service.favorites, [old_app])
	fixture.change_catalog([new_app, added])
	assert.deepEqual(fixture.service.favorites, [new_app, added])
	assert.deepEqual(fixture.notifications, ["favorites", "favorites", "list"])
	assert.equal(fixture.commands.length, 2)
})

test("parses empty defaults, typed empty arrays, and escaped strings via GVariant", async () => {
	const quoted = app("quoted.desktop", "It's Krita")
	const raw = "[\"It's Krita\"]"
	const fixture = await service_fixture([quoted], new Map([
		["[]", []], ["@as []", []], [raw, ["It's Krita"]],
	]))
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
	const errors = []
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
