# ags2-shell

[![NixOS](https://img.shields.io/badge/NixOS-Flake-blue?logo=nixos)](https://nixos.org)
[![Hyprland](https://img.shields.io/badge/Hyprland-Desktop_Shell-58e1ff?logo=wayland)](https://hyprland.org)
[![AGS](https://img.shields.io/badge/AGS-v3%2FAstal-green)](https://github.com/Aylur/ags)
[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC_BY--NC_4.0-lightgrey.svg)](LICENSE)

A GTK4 desktop shell for Hyprland, built with AGS v3 and Astal. It provides a bar, launcher, overview, dock, desktop, notifications, quick settings, capture tools, and wallpaper-aware theming through Nix and native AGS bundles.

![Demonstration](assets/thumbnail.png)

## Features

- Application launcher, favorites, taskbar, workspace overview, and a left or bottom dock with static and autohide modes
- Scrollable per-monitor desktop icons with cross-monitor drag-and-drop, clipboard, rename, launcher creation, trash, and file operations
- Notification daemon and StatusNotifier system tray
- Network, Bluetooth, audio, battery, brightness, and power-profile controls
- MPRIS media controls, volume and brightness OSDs, and color picker
- Focused-monitor and area screenshots and recordings
- Per-monitor wallpaper surfaces with optional wallpaper-generated colors
- Configurable layout, scale, typography, colors, spacing, and widget behavior

## Requirements

### Core

- AGS v3, Astal, GTK4, and GTK4 Layer Shell
- A running Hyprland session with working IPC and a correctly exported graphical-session environment
- A user D-Bus session and writable dconf/GSettings state
- No competing notification daemon; ags2-shell needs to own `org.freedesktop.Notifications` and warns when another process owns it

The Nix package currently exports `x86_64-linux` and supplies its core libraries and runtime commands. Native installations must provide those dependencies through the host distribution. Keep the AGS CLI installed for window toggles and request commands; `hyprctl` is supplied by Hyprland.

### Feature Services

| Feature                    | Host requirement                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Network controls           | NetworkManager                                                                                                                  |
| Audio controls and OSD     | PipeWire with WirePlumber                                                                                                       |
| Bluetooth                  | BlueZ service and supported hardware                                                                                            |
| Battery status             | UPower                                                                                                                          |
| Power profiles             | power-profiles-daemon, or supported ASUS services                                                                               |
| Default power-menu actions | systemd's `systemctl` and `shutdown`; logout uses `hyprctl`                                                                     |
| Internal brightness        | An accessible backlight device and permission to use `brightnessctl`                                                            |
| External brightness        | DDC/CI support and permission to use `ddcutil`                                                                                  |
| Media controls             | Players exposing MPRIS on the user bus                                                                                          |
| ASUS controls              | `asusctl`; optionally `supergfxctl` and `rog-control-center`                                                                    |
| GNOME settings shortcuts   | `gnome-control-center`; its Bluetooth panel may also require an `org.gnome.SettingsDaemon.Rfkill` provider such as `gsd-rfkill` |
| tmux accent sync           | `tmux`; detected automatically and otherwise ignored                                                                            |

Unavailable optional services disable only their corresponding controls.

## NixOS Installation

### 1. Add The Flake Inputs

Using the same `nixpkgs` and `ags` inputs keeps the shell and AGS control client aligned.

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    home-manager = {
      url = "github:nix-community/home-manager/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    ags = {
      url = "github:Aylur/ags";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    ags2-shell = {
      url = "github:TheWolfStreet/ags2-shell";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.ags.follows = "ags";
    };
  };
}
```

### 2. Install And Start The Shell

Add the shell, matching AGS CLI, GTK portal backend, and user service to Home Manager:

```nix
{
  inputs,
  pkgs,
  ...
}: let
  system = pkgs.stdenv.hostPlatform.system;
  ags = inputs.ags.packages.${system}.default;
  shell = inputs.ags2-shell.packages.${system}.default;
in {
  home.packages = [ags shell];

  # Exposes the GSettings color scheme to portal and Flatpak applications.
  xdg.portal.extraPortals = [pkgs.xdg-desktop-portal-gtk];

  systemd.user.services.ags = {
    Unit = {
      Description = "AGS desktop shell";
      Documentation = ["https://github.com/TheWolfStreet/ags2-shell"];
      After = ["graphical-session-pre.target"];
      PartOf = ["graphical-session.target"];
    };
    Service = {
      ExecStart = "${shell}/bin/ags2-shell";
      KillMode = "mixed";
      Restart = "on-failure";
    };
    Install.WantedBy = ["graphical-session.target"];
  };
}
```

The desktop session must also provide the main `xdg-desktop-portal` service and a compositor portal backend, normally `xdg-desktop-portal-hyprland`. The GTK backend is session integration rather than an application dependency: ags2-shell runs without it, but sandboxed applications will not reliably receive the shell's dark or light preference.

Apply the configuration with your normal NixOS or Home Manager switch, then verify the service:

```bash
systemctl --user status ags.service
journalctl --user -u ags.service -b
```

### 3. Add Hyprland Bindings

The AGS CLI flags belong to the `toggle` and `request` subcommands. The following bindings use the shell's `ags2-shell` instance name:

```nix
wayland.windowManager.hyprland.settings = {
  bind = let
    toggle = "exec, ags toggle --instance ags2-shell";
    request = "exec, ags request --instance ags2-shell";
  in [
    "CTRL ALT, Delete,   exec, systemctl --user restart ags.service"
    "SUPER, R,           ${toggle} launcher"
    "SUPER, Tab,         ${toggle} overview"
    "SUPER SHIFT, R,     ${toggle} quicksettings"
    ",XF86PowerOff,      ${request} shutdown"
    "SUPER, Print,       ${request} record-area"
    "SUPER SHIFT, Print, ${request} record"
    ", Print,            ${request} screenshot-area"
    "SHIFT, Print,       ${request} screenshot"
  ];

  layerrule = [
    "blur on, match:namespace gtk4-layer-shell"
    "blur_popups on, match:namespace gtk4-layer-shell"
    "ignore_alpha 0.29, match:namespace gtk4-layer-shell"
    "no_anim on, match:namespace gtk4-layer-shell"
  ];
};
```

`record` and `screenshot` target the focused monitor. Their `-area` variants prompt for a region. Repeating either recording request stops the active recording. Screenshots are saved as PNG files and copied to the clipboard; recordings are saved as MKV files. The example opens Quick Settings with `SUPER SHIFT R`; the Settings window itself is created on demand from the gear button in the Quick Settings header.

### Control API

Use `ags toggle --instance ags2-shell <window>` for the windows created at startup:

| Window          | Purpose                                      |
| --------------- | -------------------------------------------- |
| `launcher`      | Application search and favorites             |
| `overview`      | Workspaces and clients                       |
| `quicksettings` | Device controls and the Settings entry point |
| `datemenu`      | Calendar and date menu                       |
| `notifications` | Notification history                         |
| `powermenu`     | Session and power actions                    |

The Settings window is created by the gear button in Quick Settings. After that, its window name is `settings-dialog`.

Use `ags request --instance ags2-shell <request>` for actions:

| Request                   | Behavior                                                         |
| ------------------------- | ---------------------------------------------------------------- |
| `launcher-search <query>` | Open the launcher with a search query                            |
| `shutdown`                | Open shutdown confirmation                                       |
| `record`                  | Start or stop focused-monitor recording                          |
| `record-area`             | Select an area and start recording, or stop the active recording |
| `screenshot`              | Capture the focused monitor                                      |
| `screenshot-area`         | Select and capture an area                                       |

## Other Linux Distributions

On other distributions, ags2-shell installs as two AGS-bundled GJS launchers and a compiled stylesheet. It uses GTK4, GTK4 Layer Shell, GVfs metadata support, libportal, host runtime commands, and the IO, Astal4, Apps, Battery, Bluetooth, Hyprland, MPRIS, Network, Notifd, PowerProfiles, Tray, and WirePlumber Astal libraries. GVfs is required to mark generated desktop launchers as trusted.

Install AGS v3 and those Astal libraries using the [AGS installation guide](https://aylur.github.io/ags/guide/install.html) and [Astal installation guide](https://aylur.github.io/astal/guide/installation) for your distribution.

### Arch Linux Example

Install AGS and the Astal libraries from the AUR:

```bash
yay -S aylurs-gtk-shell-git libastal-meta
```

Install the build tool, shell runtime commands, and portal backends:

```bash
sudo pacman -S --needed \
  dart-sass bluez-utils brightnessctl curl dconf ddcutil gjs glib2 \
  gsettings-desktop-schemas gtk4 gtk4-layer-shell gvfs hyprland \
  gnome-control-center grim hyprpicker libheif libportal libportal-gtk4 libwebp pavucontrol \
  procps-ng slurp swappy wf-recorder wl-clipboard xdg-utils \
  xdg-desktop-portal-hyprland xdg-desktop-portal-gtk
```

Install the host services from the Feature Services table as needed. For example, network, audio, Bluetooth, battery, and power-profile controls use NetworkManager, PipeWire/WirePlumber, BlueZ, UPower, and power-profiles-daemon respectively.

### Build And Install

The native installer compiles the stylesheet, bundles the main and wallpaper entry points, and installs them under `~/.local` by default. It checks for the build commands `ags`, `sass`, `install`, and `sed`; runtime libraries and commands must be installed separately as described above.

```bash
git clone https://github.com/TheWolfStreet/ags2-shell
cd ags2-shell
./scripts/install-native.sh
```

Set `PREFIX`, `BINDIR`, `LIBEXECDIR`, or `DATADIR` to override individual installation locations.

Ensure the selected `bin` directory is in `PATH`, then add the shell to Hyprland autostart:

```ini
exec-once = ags2-shell
```

The control commands and Hyprland bindings documented above work unchanged because the native AGS installation provides the `ags` CLI.

## Appearance And Wallpapers

The shell defaults to SF Pro Display Nerd Font and is styled independently through its generated CSS. Install that font or select another one in **Settings > Appearance**. Host GTK, icon, and cursor themes remain under the desktop configuration's control.

Changing the shell's light or dark scheme updates `org.gnome.desktop.interface color-scheme`, selects an installed matching icon-theme variant when one exists, and optionally synchronizes the accent color to tmux. Wallpaper color generation is available under **Settings > Appearance > Generate from Wallpaper**.

The selected wallpaper is copied to `~/.config/background` and drawn by a supervised, separately bundled process with one surface per monitor. HEIC and WebP sources are converted to PNG with `heif-dec` and `dwebp`; other supported formats are copied directly.

## Configuration And State

Use the Settings window to change shell options. Changes are saved automatically.

| State                | Location                                          |
| -------------------- | ------------------------------------------------- |
| Shell options        | `$XDG_CACHE_HOME/ags2-shell/options.json`         |
| Desktop icon layout  | `$XDG_CACHE_HOME/ags2-shell/desktop-layout.json`  |
| Color-picker history | `$XDG_CACHE_HOME/ags2-shell/colors.json`          |
| Thumbnail cache      | `$XDG_CACHE_HOME/ags2-shell/previews/thumbnails/` |
| Wallpaper            | `~/.config/background`                            |
| Screenshots          | `~/Pictures/Screenshots/`                         |
| Recordings           | `~/Videos/Screencasting/`                         |

There is currently no declarative Nix option interface for shell settings. Removing `options.json` restores defaults on the next start.

## Development

Run the development shell from a checkout to get AGS, Sass, language tooling, and file watchers:

```bash
git clone https://github.com/TheWolfStreet/ags2-shell
cd ags2-shell
systemctl --user stop ags.service
nix develop -c ./dev.sh
systemctl --user start ags.service
```

Stop the packaged service only when it is enabled; a packaged and development instance cannot own the same `ags2-shell` name simultaneously. Build and validate the package with:

```bash
nix build
nix flake check
```

## Troubleshooting

### Service Does Not Start

```bash
systemctl --user status ags.service
journalctl --user -u ags.service -b
ags list
```

Confirm that the service inherited `WAYLAND_DISPLAY`, `HYPRLAND_INSTANCE_SIGNATURE`, and the graphical-session environment.

### Flatpak Applications Ignore The Color Scheme

Confirm that both the compositor portal backend and `xdg-desktop-portal-gtk` are installed, then restart the portal after switching configuration:

```bash
systemctl --user restart xdg-desktop-portal.service
systemctl --user restart xdg-desktop-portal-gtk.service
```

Reopen affected applications after the restart.

### Notifications Are Unavailable

Only one process can own `org.freedesktop.Notifications`. Disable another notification daemon before starting ags2-shell.

### Brightness Controls Are Missing

Verify that `brightnessctl` can access internal backlight devices and that `ddcutil detect` can access external DDC/CI displays. Device permissions must be configured by the host system.

## Acknowledgments

ags2-shell is an independent GTK4/Astal evolution of [Aylur's original AGS v1 shell](https://github.com/Aylur/dotfiles/tree/18b83b2d2c6ef2b9045edefe49a66959f93b358a). It retains that project's foundation while adding features such as a dock, desktop icons and file operations, multi-monitor wallpaper management, expanded settings, and standalone Nix packaging.

Thanks to [Aylur](https://github.com/Aylur) for AGS, Astal, and the original shell design. See [Marble Shell](https://marble-shell.pages.dev) for Aylur's current shell project.

## License

[CC BY-NC 4.0](LICENSE)
