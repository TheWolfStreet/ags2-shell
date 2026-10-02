import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { runInNewContext } from "node:vm"

const tsc = realpathSync(execFileSync("which", ["tsc"], { encoding: "utf8" }).trim())
const ts = createRequire(tsc)("../lib/node_modules/typescript/lib/typescript.js")
const source = readFileSync(new URL("../../widget/Desktop/DragAndDrop.tsx", import.meta.url), "utf8")
const ast = ts.createSourceFile("DragAndDrop.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const function_node = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "drop_action")
assert.ok(function_node, "drop_action must exist")

const actions = { MOVE: 1, COPY: 2 }
let paths = []
const compiled = ts.transpileModule(function_node.getText(ast), {
	compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText
const select = runInNewContext(`(() => {
	const DragAction = actions
	const active_drag = { peek: () => ({ paths: get_paths() }) }
	${compiled}
	return (offered, control) => drop_action({ get_actions: () => offered }, control)
})()`, { actions, get_paths: () => paths })

test("external drops prefer MOVE unless Ctrl requests offered COPY", () => {
	paths = []
	assert.equal(select(actions.MOVE | actions.COPY, false), actions.MOVE)
	assert.equal(select(actions.MOVE | actions.COPY, true), actions.COPY)
	assert.equal(select(actions.COPY, false), actions.COPY)
	assert.equal(select(actions.COPY, true), actions.COPY)
	assert.equal(select(actions.MOVE, true), actions.MOVE)
	assert.equal(select(0, false), 0)
})

test("internal desktop icon placement stays MOVE with Ctrl held", () => {
	paths = ["/home/test/Desktop/icon"]
	assert.equal(select(actions.MOVE | actions.COPY, false), actions.MOVE)
	assert.equal(select(actions.MOVE | actions.COPY, true), actions.MOVE)
	assert.equal(select(actions.MOVE, true), actions.MOVE)
	assert.equal(select(actions.COPY, true), actions.COPY)
})
