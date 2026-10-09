export type Ok<T> = { ok: true; value: T }
export type Result<T> = Ok<T> | { ok: false; err: unknown }

export function ok<T>(value: T): Result<T> {
	return { ok: true, value }
}

export function err(value: unknown): Result<never> {
	return { ok: false, err: value }
}

export function attempt<T>(fn: () => T): Result<T> {
	try {
		return ok(fn())
	} catch (error) {
		return err(error)
	}
}

export async function attempt_async<T>(
	fn: () => Promise<T>,
): Promise<Result<T>> {
	try {
		return ok(await fn())
	} catch (error) {
		return err(error)
	}
}

export function log_error<T>(result: Result<T>, tag: string): result is Ok<T> {
	if (result.ok) return true
	console.error(tag, result.err)
	return false
}

export function unwrap_or<T>(result: Result<T>, fallback: T, tag: string): T {
	if (result.ok) return result.value
	console.error(tag, result.err)
	return fallback
}

export function with_context<T>(result: Result<T>, message: string): Result<T> {
	if (result.ok) return result
	return err(new Error(message, { cause: result.err }))
}
