import Gio from "gi://Gio"
import Gdk from "gi://Gdk?version=4.0"
import Hyprland from "gi://AstalHyprland"

Gio._promisify(Gio.File.prototype, "enumerate_children_async", "enumerate_children_finish")
Gio._promisify(Gio.File.prototype, "query_info_async", "query_info_finish")
Gio._promisify(Gio.File.prototype, "make_directory_async", "make_directory_finish")
Gio._promisify(Gio.File.prototype, "delete_async", "delete_finish")
Gio._promisify(Gio.File.prototype, "trash_async", "trash_finish")
Gio._promisify(Gio.FileEnumerator.prototype, "next_files_async", "next_files_finish")
Gio._promisify(Gio.FileEnumerator.prototype, "close_async", "close_finish")
Gio._promisify(Gio.InputStream.prototype, "read_bytes_async", "read_bytes_finish")
Gio._promisify(Gio.InputStream.prototype, "close_async", "close_finish")
Gio._promisify(Gdk.Clipboard.prototype, "read_async", "read_finish")
Gio._promisify(Gdk.Drop.prototype, "read_async", "read_finish")
Gio._promisify(Hyprland.Hyprland.prototype, "message_async", "message_finish")
