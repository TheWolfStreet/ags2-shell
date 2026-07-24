// Converts errors from regular and async functions into result values.
export type Result<T> =
	| { ok: true, value: T }
	| { ok: false, err: unknown }

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

export async function attemptAsync<T>(fn: () => Promise<T>): Promise<Result<T>> {
	try {
		return ok(await fn())
	} catch (error) {
		return err(error)
	}
}
