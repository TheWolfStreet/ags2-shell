export type Result<T> =
	| { ok: true, value: T }
	| { ok: false, err: unknown }

export function attempt<T>(fn: () => T): Result<T> {
	try {
		return { ok: true, value: fn() }
	} catch (err) {
		return { ok: false, err }
	}
}

export async function attemptAsync<T>(fn: () => Promise<T>): Promise<Result<T>> {
	try {
		return { ok: true, value: await fn() }
	} catch (err) {
		return { ok: false, err }
	}
}
