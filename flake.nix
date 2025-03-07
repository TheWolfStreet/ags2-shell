{
  description = "Main desktop shell";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    apple-fonts.url = "github:Lyndeno/apple-fonts.nix";
    matugen.url = "github:InioX/matugen?ref=v2.2.0";
    ags = {
      url = "github:aylur/ags";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    nixpkgs,
    apple-fonts,
    matugen,
    ags,
    ...
  }: let
    system = "x86_64-linux";
    pkgs = nixpkgs.legacyPackages.${system};

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
      apple-fonts.packages.${pkgs.system}.sf-pro-nerd
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
        buildInputs = commonPackages;
      };
    };
  };
}
