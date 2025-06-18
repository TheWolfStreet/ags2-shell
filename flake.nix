{
  description = "Main desktop shell";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    matugen.url = "github:InioX/matugen?ref=v2.2.0";
    ags = {
      url = "github:aylur/ags";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    nixpkgs,
    matugen,
    ags,
    ...
  }: let
    system = "x86_64-linux";
    pkgs = nixpkgs.legacyPackages.${system};
    # And a few expected things in the environment like bash and which
    commonPackages = with pkgs; [
      dart-sass
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
      gtk3
      fd
      matugen.packages.${system}.default
      ags.packages.${pkgs.system}.apps
      ags.packages.${pkgs.system}.battery
      ags.packages.${pkgs.system}.hyprland
      ags.packages.${pkgs.system}.wireplumber
      ags.packages.${pkgs.system}.network
      ags.packages.${pkgs.system}.tray
      ags.packages.${pkgs.system}.notifd
      ags.packages.${pkgs.system}.mpris
      ags.packages.${pkgs.system}.bluetooth
      ags.packages.${pkgs.system}.auth
      ags.packages.${pkgs.system}.powerprofiles
    ];
  in {
    packages.${system}.default = ags.lib.bundle {
      inherit pkgs;
      src = ./.;
      name = "ags2-shell";
      entry = "app.ts";
      gtk4 = false;
      extraPackages = commonPackages;
    };

    devShells.${system} = {
      default = pkgs.mkShell {
        buildInputs =
          commonPackages
          ++ [
            pkgs.gobject-introspection
            pkgs.glib
            pkgs.gvfs
            pkgs.ags
            pkgs.vtsls
          ];

        shellHook = ''
          export GIO_EXTRA_MODULES=${pkgs.gvfs}/lib/gio/modules
          export AGS2SHELL_DEV=$PWD
        '';
      };
    };
  };
}
