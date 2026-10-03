import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"

const tsc_path = realpathSync(execFileSync("which", ["tsc"], { encoding: "utf8" }).trim())
const ts = createRequire(tsc_path)("../lib/node_modules/typescript/lib/typescript.js")
const source = readFileSync(new URL("../../widget/Bar/components/Launcher/index.tsx", import.meta.url), "utf8")
const ast = ts.createSourceFile("index.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const updates = []
function visit(node) {
	if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "update" && node.initializer)
		updates.push(node)
	ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(updates.length, 1)
const implementation = ts.transpileModule(`const ${updates[0].getText(ast)};`, {
	compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText

function available(command) {
	try { execFileSync("which", [command], { stdio: "ignore" }); return true }
	catch { return false }
}

test("native launcher rows retain positions throughout top and bottom slide transitions", {
	skip: !available("gjs") || !available("xvfb-run"),
}, () => {
	const script = `
const gi = imports.gi
gi.versions.Gtk = "4.0"
const { Gtk, GLib } = gi
Gtk.init()
const names = ["Telegram", "TextEditor", "Btop", "Steam", "Scout", "Soldier", "Sniper"]
const heights = [64, 64, 82, 64, 64, 64, 64]
const results = []
function wait(ms) {
    const loop = new GLib.MainLoop(null, false)
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { loop.quit(); return GLib.SOURCE_REMOVE })
    loop.run()
}
for (const bottom of [false, true]) {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
    const window = new Gtk.Window({ default_width: 300 })
    window.set_child(box)
    const revealers = new Map()
    for (const [index, name] of names.entries()) {
        const row = new Gtk.Revealer({ name, transition_type: bottom
            ? Gtk.RevealerTransitionType.SLIDE_UP : Gtk.RevealerTransitionType.SLIDE_DOWN,
            transition_duration: 0 })
        row.set_child(new Gtk.DrawingArea({ content_width: 200, content_height: heights[index] }))
        box.append(row)
        revealers.set(name, row)
    }
    let ordered = bottom
        ? ["Soldier", "Scout", "Steam", "Btop", "TextEditor", "Telegram"]
        : ["Telegram", "TextEditor", "Btop", "Steam", "Scout", "Soldier"]
    const entries = { peek: () => ordered }
    const visual_entries = { peek: () => visual }
    let visual = []
    const set_visual_entries = next => { visual = next }
${implementation}
    window.present()
    update()
    wait(100)
    function sample() {
        const rows = {}
        for (const [name, row] of revealers) {
            const [ok, bounds] = row.compute_bounds(box)
            rows[name] = { height: row.get_height(), y: ok ? bounds.origin.y : null,
                target: row.get_reveal_child(), revealed: row.get_child_revealed() }
        }
        const siblings = []
        for (let row = box.get_first_child(); row; row = row.get_next_sibling()) siblings.push(row.get_name())
        return { rows, siblings, visual: [...visual] }
    }
    const before = sample()
    for (const row of revealers.values()) row.set_transition_duration(420)
    ordered = bottom
        ? ["Sniper", "Soldier", "Scout", "Steam", "TextEditor", "Telegram"]
        : ["Telegram", "TextEditor", "Steam", "Scout", "Soldier", "Sniper"]
    update()
    const start = sample()
    wait(100)
    const early = sample()
    wait(120)
    const middle = sample()
    wait(350)
    const end = sample()
    ordered = bottom
        ? ["Soldier", "Scout", "Steam", "Btop", "TextEditor", "Telegram"]
        : ["Telegram", "TextEditor", "Btop", "Steam", "Scout", "Soldier"]
    update()
    wait(90)
    const returning = sample()
    ordered = bottom
        ? ["Sniper", "Soldier", "Scout", "Steam", "TextEditor", "Telegram"]
        : ["Telegram", "TextEditor", "Steam", "Scout", "Soldier", "Sniper"]
    update()
    const reversed = sample()
    wait(500)
    for (const row of revealers.values()) row.set_transition_duration(0)
    ordered = bottom
        ? ["Soldier", "Scout", "Steam", "Btop", "TextEditor", "Telegram"]
        : ["Telegram", "TextEditor", "Btop", "Steam", "Scout", "Soldier"]
    update()
    wait(40)
    const instant = sample()
    results.push({ bottom, before, start, early, middle, end, returning, reversed, instant })
    window.destroy()
}
print(JSON.stringify(results))
`
	const run = spawnSync("xvfb-run", ["-n", String(1000 + process.pid % 1000 * 20), "gjs", "-c", script], {
		encoding: "utf8", timeout: 30000, env: { ...process.env, GTK_A11Y: "none" },
	})
	assert.equal(run.status, 0, run.stderr)
	assert.doesNotMatch(run.stderr, /Gtk-(?:WARNING|CRITICAL)|Gjs-CRITICAL/)
	const results = JSON.parse(run.stdout.trim())
	for (const { bottom, before, start, early, middle, end, returning, reversed, instant } of results) {
		const outgoing = "Btop"
		const retained = bottom ? "TextEditor" : "Steam"
		assert.equal(before.rows[outgoing].height, 82)
		const stable = bottom ? ["Sniper", ...before.siblings.filter(name => name !== "Sniper")] : before.siblings
		assert.deepEqual(start.siblings, stable)
		assert.deepEqual(early.siblings, stable)
		assert.deepEqual(middle.siblings, stable)
		assert.equal(start.rows.Sniper.height, 0)
		assert.ok(early.rows.Sniper.height > 0 && early.rows.Sniper.height < 64, JSON.stringify(early))
		assert.ok(early.rows.Btop.height > 0 && early.rows.Btop.height < 82, JSON.stringify(early))
		assert.ok(middle.rows.Btop.height < early.rows.Btop.height, JSON.stringify(middle))
		assert.ok(early.rows[retained].y < before.rows[retained].y, JSON.stringify(early))
		assert.ok(middle.rows[retained].y < early.rows[retained].y, JSON.stringify(middle))
		assert.equal(end.rows.Btop.height, 0)
		assert.equal(end.rows.Sniper.height, 64)
		for (const frame of [before, start, early, middle, end]) {
			assert.ok(Math.abs(frame.rows[retained].y - frame.rows.Btop.y - frame.rows.Btop.height) <= 1,
				JSON.stringify(frame))
		}
		assert.ok(returning.rows.Btop.height > 0, JSON.stringify(returning))
		assert.equal(returning.rows.Btop.revealed, false)
		assert.deepEqual(reversed.siblings, returning.siblings)
		assert.equal(reversed.rows.Btop.height, returning.rows.Btop.height)
		assert.equal(reversed.rows.Btop.target, false)
		assert.equal(instant.rows.Btop.height, 82)
		assert.equal(instant.rows.Sniper.height, 0)
		assert.deepEqual(instant.visual, bottom
			? ["Soldier", "Scout", "Steam", "Btop", "TextEditor", "Telegram"]
			: ["Telegram", "TextEditor", "Btop", "Steam", "Scout", "Soldier"])
	}
})
