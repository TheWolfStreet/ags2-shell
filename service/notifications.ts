import GObject, { register, getter, property } from "ags/gobject"
import { timeout } from "ags/time"

import AstalNotifd from "gi://AstalNotifd"

import options from "options"

const MAX_NOTIFICATIONS = 50

@register()
export default class NotificationManager extends GObject.Object {
	declare static $gtype: GObject.GType<NotificationManager>
	static instance: NotificationManager

	static get_default(): NotificationManager {
		return this.instance ??= new NotificationManager()
	}

	#notifd: AstalNotifd.Notifd
	#notifications: Array<AstalNotifd.Notification>
	#notifyHandler: number

	@property(Boolean) dismissingAll: boolean
	@property(Boolean) popupHovered: boolean

	constructor() {
		super()

		this.#notifd = AstalNotifd.get_default()
		this.#notifications = []
		this.dismissingAll = false
		this.popupHovered = false

		this.#notifyHandler = this.#notifd.connect("notified", (_: AstalNotifd.Notifd, id: number, replaced: boolean) => {
			const notification = this.#notifd.get_notification(id)
			if (!notification) return

			const blacklist = options.notifications.blacklist.peek() || []
			const appName = notification.get_app_name() || notification.get_desktop_entry()

			if (blacklist.includes(appName)) return

			if (replaced && this.#notifications.some(n => n.id === id)) {
				this.#notifications = this.#notifications.map(n => n.id === id ? notification : n)
			} else {
				this.#notifications = [notification, ...this.#notifications].slice(0, MAX_NOTIFICATIONS)
			}

			this.notify("notifications")
		})
	}

	@getter(Array)
	get notifications(): Array<AstalNotifd.Notification> {
		return this.#notifications
	}

	removeNotification(id: number) {
		this.#notifications = this.#notifications.filter(n => n.id !== id)
		this.notify("notifications")
	}

	clearAll() {
		this.#notifications = []
		this.notify("notifications")
	}

	dismissAll(transitionDuration: number, maxStaggerDelay: number) {
		this.dismissingAll = true
		timeout(transitionDuration + maxStaggerDelay, () => {
			this.dismissingAll = false
			this.clearAll()
		})
	}

	get dontDisturb(): boolean {
		return this.#notifd.get_dont_disturb()
	}

	set dontDisturb(value: boolean) {
		this.#notifd.set_dont_disturb(value)
	}

	vfunc_finalize() {
		if (this.#notifyHandler) {
			this.#notifd.disconnect(this.#notifyHandler)
		}
		this.#notifications = []
		super.vfunc_finalize()
	}
}
