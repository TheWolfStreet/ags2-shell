# ags2-shell

[![NixOS](https://img.shields.io/badge/NixOS-Flake-blue?logo=nixos)](https://nixos.org)
[![Hyprland](https://img.shields.io/badge/Hyprland-Desktop_Shell-58e1ff?logo=wayland)](https://hyprland.org)
[![AGS](https://img.shields.io/badge/AGS-v3%2FAstal-green)](https://github.com/Aylur/ags)
[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC_BY--NC_4.0-lightgrey.svg)](LICENSE)

A GTK4 desktop shell for Hyprland, built with AGS v3 and Astal. It provides a bar, launcher, overview, dock, desktop, notifications, quick settings, capture tools, and wallpaper-aware theming through Nix and native AGS bundles.

![Demonstration](assets/thumbnail.png)

## Features

- Application launcher, favorites, dock, taskbar, and workspace overview
- Desktop icons with drag-and-drop, clipboard, rename, trash, and file operations
- Notification daemon and StatusNotifier system tray
- Network, Bluetooth, audio, battery, brightness, and power-profile controls
- MPRIS media controls, volume and brightness OSDs, and color picker
- Focused-monitor and area screenshots and recordings
- Per-monitor wallpaper surfaces with optional wallpaper-generated colors
- Configurable layout, scale, typography, colors, spacing, and widget behavior

## Requirements

### Core

- AGS v3, Astal, GTK4, and GTK4 Layer Shell
- A running Hyprland session with working IPC and systemd user-session integration
- A user D-Bus session and writable dconf/GSettings state
- No competing notification daemon; ags2-shell owns `org.freedesktop.Notifications`

The Nix package currently exports `x86_64-linux` and supplies its core libraries and runtime commands. Native installations must provide those dependencies through the host distribution. Keep the AGS CLI installed for window toggles and request commands; `hyprctl` is supplied by Hyprland.

### Feature Services

| Feature | Host requirement |
| --- | --- |
| Network controls | NetworkManager |
| Audio controls and OSD | PipeWire with WirePlumber |
| Bluetooth | BlueZ service and supported hardware |
| Battery status | UPower |
| Power profiles | power-profiles-daemon, or supported ASUS services |
| Internal brightness | An accessible backlight device and permission to use `brightnessctl` |
| External brightness | DDC/CI support and permission to use `ddcutil` |
| Media controls | Players exposing MPRIS on the user bus |
| ASUS controls | `asusctl`; optionally `supergfxctl` and `rog-control-center` |
| tmux accent sync | `tmux`; detected automatically and otherwise ignored |

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

    apple-fonts = {
      url = "github:Lyndeno/apple-fonts.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    mactahoe-icon-theme = {
      url = "github:TheWolfStreet/MacTahoe-icon-theme.nix";
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

The font and icon-theme inputs are used by the recommended appearance configuration below. They can be omitted if you use different themes.

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
    "SUPER SHIFT, R,     ${toggle} settings-dialog"
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

`record` and `screenshot` target the focused monitor. Their `-area` variants prompt for a region.

The same controls can be called directly:

```bash
ags toggle --instance ags2-shell launcher
ags request --instance ags2-shell launcher-search firefox
ags request --instance ags2-shell screenshot-area
```

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

The native installer compiles the stylesheet, bundles the main and wallpaper entry points, and installs them under `~/.local` by default:

```bash
git clone https://github.com/TheWolfStreet/ags2-shell
cd ags2-shell
./scripts/install-native.sh
```

Ensure the selected `bin` directory is in `PATH`, then add the shell to Hyprland autostart:

```ini
exec-once = ags2-shell
```

The control commands and Hyprland bindings documented above work unchanged because the native AGS installation provides the `ags` CLI.

## Recommended Appearance

The default shell font is SF Pro Display Nerd Font. The following Home Manager configuration installs the font, MacTahoe icons, Qogir cursor, and matching GTK theme used by the reference setup:

```nix
{
  inputs,
  pkgs,
  ...
}: let
  system = pkgs.stdenv.hostPlatform.system;
  font = {
    name = "SF Pro Display Nerd Font";
    size = 11;
    package = inputs.apple-fonts.packages.${system}.sf-pro-nerd;
  };
  gtkTheme = {
    name = "adw-gtk3-dark";
    package = pkgs.adw-gtk3;
  };
  cursorTheme = {
    name = "Qogir";
    size = 24;
    package = pkgs.qogir-icon-theme;
  };
  iconTheme = {
    name = "MacTahoe";
    package = inputs.mactahoe-icon-theme.packages.${system}.default;
  };
in {
  home.packages = [
    font.package
    gtkTheme.package
    cursorTheme.package
    iconTheme.package
  ];

  home.pointerCursor = cursorTheme // {
    enable = true;
    gtk.enable = true;
  };

  home.sessionVariables = {
    XCURSOR_THEME = cursorTheme.name;
    XCURSOR_SIZE = toString cursorTheme.size;
  };

  fonts.fontconfig.enable = true;

  gtk = {
    enable = true;
    theme = gtkTheme;
    inherit font cursorTheme iconTheme;
  };

  qt.platformTheme.name = "gtk3";
}
```

ags2-shell controls its own widgets through generated CSS. It does not replace the host GTK or cursor theme. When the shell's light or dark scheme changes, it updates `org.gnome.desktop.interface color-scheme` and selects an installed light or dark icon-theme variant when available. Wallpaper color generation is optional and can be enabled from **Settings > Appearance > Generate from Wallpaper**.

## Recommended Hyprlock

Enable Hyprlock and its PAM service, then add the Home Manager configuration below. The example uses the recommended SF Pro font and the account image at `/var/lib/AccountsService/icons/$USER`.

```nix
# NixOS configuration
security.pam.services.hyprlock = {};
```

```nix
# Home Manager configuration
programs.hyprlock = {
  enable = true;
  settings = {
    background = {
      path = "screenshot";
      blur_passes = 5;
      contrast = 0.8916;
      brightness = 0.8172;
      vibrancy = 0.1696;
      vibrancy_darkness = 0.0;
    };

    general = {
      no_fade_in = false;
      grace = 0;
      disable_loading_bar = false;
    };

    label = [
      {
        text = ''cmd[update:1000] echo -e "$(date +"%A, %B %d")"'';
        color = "rgba(216, 222, 233, 0.70)";
        font_size = 25;
        font_family = "SF Pro Display Nerd Font Bold";
        position = "0, 350";
        halign = "center";
        valign = "center";
      }
      {
        text = ''cmd[update:1000] echo "<span>$(date +"%H:%M")</span>"'';
        color = "rgba(216, 222, 233, 0.70)";
        font_size = 120;
        font_family = "SF Pro Display Nerd Font Bold";
        position = "0, 250";
        halign = "center";
        valign = "center";
      }
      {
        text = "$USER";
        color = "rgba(216, 222, 233, 0.80)";
        font_size = 20;
        font_family = "SF Pro Display Nerd Font Bold";
        position = "0, -82";
        halign = "center";
        valign = "center";
      }
    ];

    image = {
      path = "/var/lib/AccountsService/icons/$USER";
      border_size = 2;
      border_color = "rgba(255, 255, 255, .65)";
      size = 180;
      rounding = -1;
      position = "0, 40";
      halign = "center";
      valign = "center";
    };

    input-field = {
      size = "125, 50";
      dots_center = true;
      outline_thickness = 0;
      outer_color = "rgba(0, 0, 0, 0)";
      inner_color = "rgba(255, 255, 255, 0.1)";
      check_color = "rgba(255, 255, 255, 0.1)";
      fail_color = "rgba(255, 255, 255, 0.1)";
      capslock_color = "rgba(255, 255, 255, 0.1)";
      numlock_color = "rgba(255, 255, 255, 0.1)";
      bothlock_color = "rgba(255, 255, 255, 0.1)";
      font_color = "rgb(200, 200, 200)";
      fade_on_empty = false;
      font_family = "SF Pro Display Nerd Font Regular";
      placeholder_text = "Password";
      fail_text = "Incorrect";
      hide_input = false;
      position = "0, -140";
      halign = "center";
      valign = "center";
    };
  };
};
```

## Configuration And State

Use the Settings window to change shell options. Changes are saved automatically.

| State | Location |
| --- | --- |
| Shell options | `$XDG_CACHE_HOME/ags2-shell/options.json` |
| Desktop icon layout | `$XDG_CACHE_HOME/ags2-shell/desktop-layout.json` |
| Color-picker history | `$XDG_CACHE_HOME/ags2-shell/colors.json` |
| Thumbnail cache | `$XDG_CACHE_HOME/ags2-shell/previews/thumbnails/` |
| Wallpaper | `~/.config/background` |
| Screenshots | `~/Pictures/Screenshots/` |
| Recordings | `~/Videos/Screencasting/` |

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
