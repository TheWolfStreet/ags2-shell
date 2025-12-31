{
  description = "A desktop shell";

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

    # Runtime packages (no build-time deps like sass/fd)
    runtimePackages = with pkgs;
      astalPackages
      ++ [
        matugen
        libadwaita
        libsoup_3
        brightnessctl
        swww
        which
        libnotify
        libheif
        wf-recorder
        wl-clipboard
        slurp
        wayshot
        swappy
        hyprpicker
        pavucontrol
        networkmanager
      ];

    extraPackages = runtimePackages ++ [pkgs.dart-sass];
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
          nodejs
        ];

        buildInputs = runtimePackages ++ [pkgs.gjs];

        buildPhase = ''
          runHook preBuild

          # Compile SCSS to CSS
          node style/build.ts

          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall

          mkdir -p $out/bin
          mkdir -p $out/share
          cp -r * $out/share
          ags bundle ${entry} $out/bin/${pname} -d "SRC='$out/share'"

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
            inherit extraPackages;
          })
          pkgs.vtsls
        ];

        shellHook = ''
          export GIO_EXTRA_MODULES=${pkgs.gvfs}/lib/gio/modules
          export AGS2SHELL_STYLES=$PWD
        '';
      };
    };
  };
}
