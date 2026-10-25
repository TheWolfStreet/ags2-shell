export type ok<T> = { ok: true; value: T }
export type result<T> = ok<T> | { ok: false; err: unknown }

export function ok<T>(value: T): result<T> {
	return { ok: true, value }
}

export function err(value: unknown): result<never> {
	return { ok: false, err: value }
}

export function attempt<T>(fn: () => T): result<T> {
	try {
		return ok(fn())
	} catch (error) {
		return err(error)
	}
}

export async function attempt_async<T>(
	fn: () => Promise<T>,
): Promise<result<T>> {
	try {
		return ok(await fn())
	} catch (error) {
		return err(error)
	}
}

export function log_error<T>(result: result<T>, tag: string): result is ok<T> {
	if (result.ok) return true
	console.error(tag, result.err)
	return false
}

export function unwrap_or<T>(result: result<T>, fallback: T, tag: string): T {
	if (result.ok) return result.value
	console.error(tag, result.err)
	return fallback
}

export function with_context<T>(result: result<T>, message: string): result<T> {
	if (result.ok) return result
	return err(new Error(message, { cause: result.err }))
}

export function log_refusal(
	done: result<boolean>,
	tag: string,
	refusal: string,
): boolean {
	if (!done.ok) console.error(tag, done.err)
	else if (!done.value) console.error(tag, refusal)
	return done.ok && done.value
}
