{
  description = "Main desktop shell";
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    ags = {
      url = "github:aylur/ags";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    self,
    nixpkgs,
    ags,
  }: let
    system = "x86_64-linux";
    pkgs = nixpkgs.legacyPackages.${system};
  in {
    devShells.${system} = {
      default = pkgs.mkShell {
        buildInputs = with pkgs; [
          vscode-langservers-extracted
          vtsls
          matugen
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
          ags.packages.${system}.agsFull
        ];
      };
    };
  };
}
