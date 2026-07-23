{
  description = "Hyprland desktop shell using AGS v3/Astal - widgets, notifications, app launcher, and dynamic matugen theming. NixOS ready.";

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
    entry = "app.tsx";
    wallpaperEntry = "wallpaper.tsx";

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
      auth
      powerprofiles
    ];

    runtimePackages = with pkgs;
      astalPackages
      ++ [
        ddcutil
        matugen
        libadwaita
        libsoup_3
        brightnessctl
        libwebp
        which
        libnotify
        libheif
        wf-recorder
        wl-clipboard
        grim
        slurp
        swappy
        hyprpicker
        pavucontrol
        networkmanager
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

        buildInputs = runtimePackages ++ [pkgs.gjs];

        buildPhase = ''
          runHook preBuild
          style/compile/build.sh
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall

          mkdir -p $out/bin
          mkdir -p $out/libexec
          mkdir -p $out/share
          cp -r * $out/share
          ags bundle ${wallpaperEntry} $out/libexec/${pname}-wallpaper -g 4 -d "SRC='$out/share'"
          ags bundle ${entry} $out/bin/${pname} \
            -d "SRC='$out/share'" \
            -d "WALLPAPER_BIN='$out/libexec/${pname}-wallpaper'"
          substituteInPlace $out/libexec/${pname}-wallpaper \
            --replace-fail 'dmFyIF-ags.js' '${pname}-wallpaper-ags.js'
          substituteInPlace $out/bin/${pname} \
            --replace-fail 'dmFyIF-ags.js' '${pname}-main-ags.js'

          runHook postInstall
        '';
        postInstall = ''
          wrapProgram $out/bin/${pname} \
          	--prefix PATH : ${pkgs.lib.makeBinPath runtimePackages} \
          	--set AGS2SHELL_STYLES $out/share
        '';
      };
    };

    devShells.${system} = {
      default = pkgs.mkShell {
        buildInputs = [
          (ags.packages.${system}.default.override {
            extraPackages = runtimePackages;
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
