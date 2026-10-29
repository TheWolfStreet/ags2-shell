import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import test from "node:test"
import ts from "../typescript.ts"

const root = new URL("../../", import.meta.url)

const source_directories = [
	"lib",
	"service",
	"shell",
	"style",
	"widget",
	"tests",
]

const files = source_directories
	.flatMap((directory) =>
		readdirSync(new URL(directory, root), { recursive: true }).map(
			(entry) => `${directory}/${entry}`,
		),
	)
	.filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".d.ts"))
	.sort()

const production = files.filter((file) => !file.startsWith("tests/"))

const allowed_throws: Record<string, number> = {
	"widget/Settings/index.tsx": 1,
}

const snake = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/
const pascal = /^[A-Z][A-Za-z0-9]*$/
const log_tag =
	/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*:( [A-Z]| ?$)|^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*\.$/

function parse(file: string) {
	const source = readFileSync(new URL(file, root), "utf8")
	const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
}

function where(source, node) {
	const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
	return `${source.fileName}:${line + 1}`
}

function walk(node, visit: (node) => void) {
	visit(node)
	ts.forEachChild(node, (child) => walk(child, visit))
}

function violations(scope: string[], check: (source, node) => string | null) {
	const found: string[] = []
	for (const file of scope) {
		const source = parse(file)
		walk(source, (node) => {
			const problem = check(source, node)
			if (problem) found.push(`${where(source, node)} ${problem}`)
		})
	}
	return found
}

function is_loop(node) {
	return (
		ts.isForStatement(node) ||
		ts.isForOfStatement(node) ||
		ts.isForInStatement(node) ||
		ts.isWhileStatement(node)
	)
}

function single_statement(body) {
	if (!ts.isBlock(body)) return body
	return body.statements.length === 1 ? body.statements[0] : null
}

function can_be_bare(body, followed_by_else: boolean) {
	const inner = single_statement(body)
	if (!inner) return false
	if (ts.isVariableStatement(inner) || ts.isFunctionDeclaration(inner))
		return false
	if (ts.isClassDeclaration(inner)) return false
	if (followed_by_else && (ts.isIfStatement(inner) || is_loop(inner)))
		return false
	return true
}

function if_chain(node) {
	const branches: [unknown, boolean][] = []
	let current = node
	while (true) {
		branches.push([current.thenStatement, Boolean(current.elseStatement)])
		const next = current.elseStatement
		if (next && ts.isIfStatement(next)) {
			current = next
			continue
		}
		if (next) branches.push([next, false])
		return branches
	}
}

test("single-statement bodies are bare unless their if chain needs braces", () => {
	const found = violations(files, (_source, node) => {
		if (is_loop(node) && ts.isBlock(node.statement))
			return can_be_bare(node.statement, false) ? "braced loop body" : null
		if (!ts.isIfStatement(node)) return null
		const parent = node.parent
		if (ts.isIfStatement(parent) && parent.elseStatement === node) return null
		const branches = if_chain(node)
		const bare = branches.every(([body, has_else]) =>
			can_be_bare(body, has_else),
		)
		const braced = branches.map(([body]) => ts.isBlock(body))
		if (bare && braced.some(Boolean)) return "braced single-statement if"
		if (!bare && !braced.every(Boolean)) return "if chain mixes braces"
		return null
	})
	assert.deepEqual(found, [])
})

test("arrows return expressions directly", () => {
	const found = violations(files, (_source, node) => {
		if (!ts.isArrowFunction(node) || !ts.isBlock(node.body)) return null
		const [only] = node.body.statements
		if (node.body.statements.length !== 1) return null
		if (!ts.isReturnStatement(only) || !only.expression) return null
		return "arrow body is a lone return"
	})
	assert.deepEqual(found, [])
})

test("declarations use plain types, snake_case names and function syntax", () => {
	const found = violations(files, (source, node) => {
		if (ts.isInterfaceDeclaration(node)) return "interface"
		if (ts.isTypeAliasDeclaration(node) && !snake.test(node.name.text))
			return `type ${node.name.text} is not snake_case`
		if (!ts.isVariableStatement(node)) return null
		const parent = node.parent
		if (!ts.isSourceFile(parent) && !ts.isModuleBlock(parent)) return null
		const arrow = node.declarationList.declarations.find(
			(declaration) =>
				declaration.initializer && ts.isArrowFunction(declaration.initializer),
		)
		return arrow ? `${arrow.name.getText(source)} is an arrow constant` : null
	})
	assert.deepEqual(found, [])
})

test("no chained ternaries", () => {
	const found = violations(files, (_source, node) => {
		if (!ts.isConditionalExpression(node)) return null
		const nested =
			ts.isConditionalExpression(node.whenTrue) ||
			ts.isConditionalExpression(node.whenFalse)
		return nested ? "chained ternary" : null
	})
	assert.deepEqual(found, [])
})

test("no comments other than compiler directives and external BUG notes", () => {
	const found: string[] = []
	for (const file of files) {
		const source = parse(file)
		walk(source, (node) => {
			const ranges = ts.getLeadingCommentRanges(source.text, node.pos) ?? []
			let bug_line = -2
			for (const range of ranges) {
				const text = source.text.slice(range.pos, range.end)
				const { line } = source.getLineAndCharacterOfPosition(range.pos)
				if (/^\/\/\s*@ts-expect-error/.test(text)) continue
				if (/^\/\/ BUG: /.test(text) || line === bug_line + 1) {
					bug_line = line
					continue
				}
				found.push(`${file}:${line + 1} ${text.split("\n")[0]}`)
			}
		})
	}
	assert.deepEqual([...new Set(found)], [])
})

test("declared names are snake_case, PascalCase only for components and classes", () => {
	const found = violations(production, (source, node) => {
		if (ts.isClassDeclaration(node) && node.name)
			return pascal.test(node.name.text) ? null : "class is not PascalCase"
		if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
			const name = node.name.text
			if (snake.test(name)) return null
			if (pascal.test(name) && source.fileName.endsWith(".tsx")) return null
			return `namespace ${name}`
		}
		const named =
			ts.isFunctionDeclaration(node) ||
			ts.isVariableDeclaration(node) ||
			ts.isParameter(node) ||
			ts.isBindingElement(node)
		if (!named || !node.name || !ts.isIdentifier(node.name)) return null
		const name = node.name.text
		if (snake.test(name)) return null
		if (ts.isParameter(node) && /^_[a-z0-9_]*$/.test(name)) return null
		if (ts.isBindingElement(node) && !node.propertyName) return null
		if (pascal.test(name) && source.fileName.endsWith(".tsx")) return null
		if (pascal.test(name) && ts.isVariableDeclaration(node)) {
			const init = node.initializer?.getText(source) ?? ""
			if (/registerClass|^class\b|\.constructor as new/.test(init)) return null
		}
		return `${name} is not snake_case`
	})
	assert.deepEqual(found, [])
})

test("file names are snake_case, PascalCase only for files exporting a component", () => {
	const found: string[] = []
	for (const file of files) {
		const name = file
			.split("/")
			.at(-1)!
			.replace(/\.test\.ts$|\.tsx?$/, "")
		if (snake.test(name) || name === "index") continue
		const exports_component =
			/^export (default )?(function|namespace) [A-Z]/m.test(
				readFileSync(new URL(file, root), "utf8"),
			)
		if (pascal.test(name) && file.endsWith(".tsx") && exports_component)
			continue
		found.push(file)
	}
	assert.deepEqual(found, [])
})

test("log messages start with a snake_case area tag", () => {
	const found = violations(production, (_source, node) => {
		if (!ts.isCallExpression(node)) return null
		const callee = node.expression
		let message: any = null
		if (
			ts.isPropertyAccessExpression(callee) &&
			ts.isIdentifier(callee.expression) &&
			callee.expression.text === "console"
		)
			message = node.arguments[0]
		if (ts.isIdentifier(callee) && callee.text === "log_error")
			message = node.arguments[1]
		if (ts.isIdentifier(callee) && callee.text === "unwrap_or")
			message = node.arguments[2]
		if (!message) return null
		let text: string | null = null
		if (
			ts.isStringLiteral(message) ||
			ts.isNoSubstitutionTemplateLiteral(message)
		)
			text = message.text
		if (ts.isTemplateExpression(message)) text = message.head.text
		if (text === null || log_tag.test(text)) return null
		return `log message ${JSON.stringify(text)}`
	})
	assert.deepEqual(found, [])
})

test("expected failures are results, not throws", () => {
	const counts: Record<string, number> = {}
	for (const file of production)
		walk(parse(file), (node) => {
			if (ts.isThrowStatement(node)) counts[file] = (counts[file] ?? 0) + 1
		})
	assert.deepEqual(counts, allowed_throws)
})
