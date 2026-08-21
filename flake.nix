# Builds the application and includes its development tools and required programs.
{
  description = "Hyprland desktop shell using AGS v3/Astal with wallpaper-aware dynamic theming.";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";

    ags = {
      url = "github:aylur/ags";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    nixpkgs,
    ags,
    ...
  }: let
    system = "x86_64-linux";
    pkgs = nixpkgs.legacyPackages.${system};
    pname = "ags2-shell";
    entry = "shell/main.tsx";
    wallpaperEntry = "shell/wallpaper.tsx";

    astalPackages = with ags.packages.${system}; [
      io
      astal4
      battery
      apps
      hyprland
      wireplumber
      network
      tray
      notifd
      mpris
      bluetooth
      powerprofiles
    ];

    runtimeLibraries =
      astalPackages
      ++ (with pkgs; [
        dconf
        gsettings-desktop-schemas
        gvfs
        libportal-gtk4
      ]);

    girPackages = runtimeLibraries ++ [pkgs.libportal-gtk4.dev];

    runtimePrograms = with pkgs; [
      bash
      bluez
      brightnessctl
      coreutils
      curl
      dconf
      ddcutil
      glib
      gnome-control-center
      grim
      hyprpicker
      libheif
      libwebp
      pavucontrol
      procps
      slurp
      swappy
      systemd
      wf-recorder
      wl-clipboard
      xdg-utils
    ];
  in {
    packages.${system} = {
      default = pkgs.stdenv.mkDerivation {
        name = pname;
        src = ./.;

        nativeBuildInputs = with pkgs; [
          wrapGAppsHook4
          gobject-introspection
          ags.packages.${system}.default
          dart-sass
        ];

        buildInputs = girPackages ++ [pkgs.gjs];

        buildPhase = ''
          runHook preBuild
          bash style/compile/build.sh
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall

          install -Dm644 style/compile/main.css $out/share/${pname}/style/compile/main.css
          mkdir -p $out/bin $out/libexec

          ags bundle ${wallpaperEntry} $out/libexec/${pname}-wallpaper -g 4
          ags bundle ${entry} $out/bin/${pname} \
            -d "WALLPAPER_BIN='$out/libexec/${pname}-wallpaper'" \
            -d "STYLE_DIR='$out/share/${pname}'"

          # AGS derives the extracted module name from its encoded prefix, so
          # independently bundled entry points otherwise overwrite each other.
          substituteInPlace $out/libexec/${pname}-wallpaper \
            --replace-fail 'dmFyIF-ags.js' '${pname}-wallpaper-ags.js'
          substituteInPlace $out/bin/${pname} \
            --replace-fail 'dmFyIF-ags.js' '${pname}-main-ags.js'

          runHook postInstall
        '';

        preFixup = ''
          gappsWrapperArgs+=(
            --prefix PATH : "${pkgs.lib.makeBinPath runtimePrograms}"
            --set AGS2SHELL_STYLES "$out/share/${pname}"
          )
        '';

        meta = {
          mainProgram = pname;
          platforms = [system];
        };
      };
    };

    devShells.${system} = {
      default = pkgs.mkShell {
        packages =
          runtimePrograms
          ++ [
            (ags.packages.${system}.default.override {
              extraPackages = girPackages;
            })
            pkgs.dart-sass
            pkgs.vtsls
            pkgs.inotify-tools
          ];

        shellHook = ''
          export GIO_EXTRA_MODULES=${pkgs.gvfs}/lib/gio/modules
          export AGS2SHELL_STYLES=$PWD
        '';
      };
    };
  };
}
