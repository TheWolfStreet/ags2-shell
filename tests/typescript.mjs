import { createRequire } from "node:module"

const api = process.env.AGS2SHELL_TYPESCRIPT
if (!api)
	throw new Error(
		"AGS2SHELL_TYPESCRIPT is unset; run the tests from nix develop",
	)

export default createRequire(import.meta.url)(api)
