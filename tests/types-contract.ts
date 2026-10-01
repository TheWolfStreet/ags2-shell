import app from "$lib/app"

const window = app.get_window("settings-dialog")
window?.show()
// @ts-expect-error
window.show()
