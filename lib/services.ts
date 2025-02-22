import Media from "gi://AstalMpris"
import Hyprland from "gi://AstalHyprland"
import Battery from "gi://AstalBattery"
import Tray from "gi://AstalTray"
import Audio from "gi://AstalWp"
import PowerProfiles from "gi://AstalPowerProfiles"
import Notifd from "gi://AstalNotifd"
import Bluetooth from "gi://AstalBluetooth"
import Network from "gi://AstalNetwork"

import Apps from "../service/apps"
import Asusctl from "../service/asusctl"
import Brightness from "../service/brightness"
import ColorPicker from "../service/colorpicker"
import PowerMenu from "../service/powermenu"
import Wallpaper from "../service/wallpaper"
import Recorder from "../service/screenrecord"

export const media = Media.get_default()
export const hypr = Hyprland.get_default()
export const bat = Battery.get_default()
export const tray = Tray.get_default()
export const audio = Audio.get_default()
export const pp = PowerProfiles.get_default()
export const notifd = Notifd.get_default()
export const bt = Bluetooth.get_default()
export const net = Network.get_default()

export const apps = Apps.get_default()
export const asusctl = Asusctl.get_default()
export const brightness = Brightness.get_default()
export const cpick = ColorPicker.get_default()
export const powermenu = PowerMenu.get_default()
export const wp = Wallpaper.get_default()
export const scr = Recorder.get_default()
