import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { SourceTextModule, SyntheticModule, type Context } from "node:vm"
import ts from "./typescript.ts"
import * as icons from "../lib/icons.ts"
import * as json from "../lib/json.ts"
import * as lua from "../lib/lua.ts"
import * as text from "../lib/text.ts"
import * as result from "../lib/result.ts"

type module_exports = Record<string, unknown>

const pure_modules: Record<string, module_exports> = {
	"$lib/icons": icons,
	"$lib/json": json,
	"$lib/lua": lua,
	"$lib/result": result,
	"$lib/text": text,
}

function compile(path: string): string {
	const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
	return ts.transpileModule(source, {
		fileName: path,
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
			experimentalDecorators: true,
			jsx: ts.JsxEmit.ReactJSX,
			jsxImportSource: "ags/gtk4",
		},
	}).outputText
}

export async function load_module(
	path: string,
	imports: Record<string, module_exports> = {},
	context?: Context,
): Promise<Record<string, any>> {
	const module = new SourceTextModule(compile(path), { context })
	await module.link((name) => {
		const exports = imports[name] ?? pure_modules[name]
		assert.ok(exports, `${path} imports unstubbed ${name}`)
		return new SyntheticModule(
			Object.keys(exports),
			function () {
				for (const [key, value] of Object.entries(exports))
					this.setExport(key, value)
			},
			{ context },
		)
	})
	await module.evaluate()
	return module.namespace as Record<string, any>
}
