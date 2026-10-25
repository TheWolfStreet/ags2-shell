export type node = {
	type: unknown
	props: Record<string, any>
	[key: string]: any
}

export function tick() {
	return new Promise((resolve) => setImmediate(resolve))
}

export function accessor(
	get: () => any,
	subscribe = (_callback: () => void) => () => {},
): any {
	function call(compute?: (value) => unknown) {
		if (compute) return accessor(() => compute(get()), subscribe)
		return get()
	}
	return Object.assign(call, {
		peek: get,
		subscribe,
		as: (compute: (value) => unknown) =>
			accessor(() => compute(get()), subscribe),
	})
}

export function read(value) {
	return typeof value === "function" ? value() : value
}

export function create_state(initial) {
	let value = initial
	const subscribers = new Set<() => void>()
	const get = accessor(
		() => value,
		(callback) => {
			subscribers.add(callback)
			return () => subscribers.delete(callback)
		},
	)
	function set(next) {
		value = typeof next === "function" ? next(value) : next
		for (const callback of [...subscribers]) callback()
	}
	return [get, set, subscribers] as const
}

export function make(type, props: Record<string, any> = {}) {
	if (typeof type === "function") return type(props)
	const children = Array.isArray(props.children)
		? props.children
		: [props.children]
	return { type, props, children: children.filter(Boolean) }
}

export const jsx_runtime = {
	jsx: make,
	jsxs: make,
	Fragment: ({ children }) => children,
}

function is_node(value): value is node {
	return Boolean(value) && typeof value === "object" && "props" in value
}

function walk(value): any[] {
	if (Array.isArray(value)) return value.flatMap(walk)
	if (!is_node(value)) return []
	const props = value.props
	if (value.type === "with")
		return [value, ...walk(props.children(props.value()))]
	if (value.type === "for")
		return [value, ...walk(props.each().map(props.children))]
	return [value, ...Object.values(props).flatMap(walk)]
}

export function nodes(root, type?: unknown): any[] {
	const found = walk(root)
	if (type === undefined) return found
	return found.filter((node) => node.type === type)
}

export function shell_quote(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`
}
