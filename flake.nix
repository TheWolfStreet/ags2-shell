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
    self,
    nixpkgs,
    ags,
    ...
  }: let
    system = "x86_64-linux";
    pkgs = nixpkgs.legacyPackages.${system};
    pname = "ags2-shell";
    entry = "shell/main.tsx";
    wallpaper_entry = "shell/wallpaper.tsx";

    astal_packages = with ags.packages.${system}; [
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

    runtime_libraries =
      astal_packages
      ++ (with pkgs; [
        dconf
        gsettings-desktop-schemas
        gvfs
        libportal-gtk4
      ]);

    gir_packages = runtime_libraries ++ [pkgs.libportal-gtk4.dev];

    gir_cli = pkgs.runCommand "ags2-shell-gir-cli" {} ''
      mkdir -p $out/lib/ts-for-gir
      tar -xzf ${pkgs.fetchurl {
        url = "https://registry.npmjs.org/@ts-for-gir/cli/-/cli-4.1.0.tgz";
        hash = "sha512-dnT4ki5AIo++C5UBM+IXlc0fmEv5nyinJG2q9I+QiW+0aI62De6949dXvwAV2QhSpCpQjPPCJHNaxVU3AIsdTg==";
      }} -C $out/lib/ts-for-gir --strip-components=1
      cp $out/lib/ts-for-gir/package.json $out/lib/package.json
      substituteInPlace $out/lib/package.json \
        --replace-fail '"version": "4.1.0",' '"version": "4.1.0", "peerDependencies": { "typescript": "^5.9.3" },'
    '';

    gir_templates = pkgs.runCommand "ags2-shell-gir-templates" {} ''
      mkdir -p $out
      tar -xzf ${pkgs.fetchurl {
        url = "https://registry.npmjs.org/@ts-for-gir/templates/-/templates-4.1.0.tgz";
        hash = "sha512-9gL6EM4dME0Ha0PAIJOtNrE7yTPhGqRbZ5meWRo2YAv6nR4pnAy5b6B9E88rmsWFKN5u6CSKs4hdPzEXbK0xhw==";
      }} -C $out --strip-components=1
    '';

    gir_dirs = let
      deps_of = pkg: [(pkg.dev or pkg)] ++ map deps_of (pkg.propagatedBuildInputs or []);
    in pkgs.symlinkJoin {
      name = "ags2-shell-gir-dirs";
      paths = pkgs.lib.flatten (map deps_of (gir_packages ++ [pkgs.gtk4 pkgs.libsoup_3 pkgs.libadwaita pkgs.gobject-introspection.dev]));
    };

    runtime_programs = with pkgs; [
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
      util-linux
      wf-recorder
      wl-clipboard
      xdg-utils
    ];
  in {
    checks.${system} = {
      package = self.packages.${system}.default;
      tests = pkgs.stdenvNoCC.mkDerivation {
        name = "ags2-shell-tests";
        src = ./.;
        nativeBuildInputs = with pkgs; [
          nodejs typescript bash dart-sass diffutils procps util-linux inotify-tools which coreutils
          gjs xvfb-run gobject-introspection sway-unwrapped wl-clipboard dbus
          ags.packages.${system}.default
        ];
        buildInputs = gir_packages ++ [pkgs.gtk4];
        buildPhase = ''
          runHook preBuild
          export HOME=$TMPDIR
          export GTK_A11Y=none
          if [ -e node_modules ]; then rm -r node_modules; fi
          mkdir node_modules
          ln -s ${ags.packages.${system}.default.jsPackage} node_modules/ags
          ln -s ${ags.packages.${system}.default.jsPackage}/node_modules/gnim node_modules/gnim
          test -f tests/scripts/options.test.mjs
          test -f tests/scripts/dev.test.mjs
          test -f tests/scripts/style.test.mjs
          test -f tests/scripts/bundle.test.mjs
          export BUNDLED_MAIN=${self.packages.${system}.default}/bin/.${pname}-wrapped
          export BUNDLED_WALLPAPER=${self.packages.${system}.default}/libexec/.${pname}-wallpaper-wrapped
          export SWAY_HEADLESS_BIN=${pkgs.sway-unwrapped}/bin/sway
          dbus-run-session --config-file=${pkgs.dbus}/share/dbus-1/session.conf -- npm test
          runHook postBuild
        '';
        installPhase = ''
          mkdir -p $out
          touch $out/passed
        '';
      };
      native = pkgs.stdenvNoCC.mkDerivation {
        name = "ags2-shell-native-smoke";
        src = ./.;
        nativeBuildInputs = with pkgs; [gjs gobject-introspection];
        buildInputs = gir_packages ++ [pkgs.gtk4];
        buildPhase = ''
          runHook preBuild
          export HOME=$TMPDIR XDG_RUNTIME_DIR=$TMPDIR
          unset HYPRLAND_INSTANCE_SIGNATURE
          test -f lib/native.ts
          test -f tests/native-smoke.js
          ${pkgs.gjs}/bin/gjs -m tests/native-smoke.js
          runHook postBuild
        '';
        installPhase = ''
          mkdir -p $out
          touch $out/passed
        '';
      };
      verification = pkgs.stdenvNoCC.mkDerivation {
        name = "ags2-shell-verification";
        src = ./.;
        nativeBuildInputs = with pkgs; [
          nodejs typescript gjs gobject-introspection bash coreutils
        ];
        buildInputs = gir_packages ++ [pkgs.gtk4 pkgs.libsoup_3 pkgs.libadwaita];
        buildPhase = ''
          runHook preBuild
          export HOME=$TMPDIR
          if [ -e node_modules ]; then rm -r node_modules; fi
          mkdir node_modules
          ln -s ${ags.packages.${system}.default.jsPackage} node_modules/ags
          ln -s ${ags.packages.${system}.default.jsPackage}/node_modules/gnim node_modules/gnim
          if [ -e @girs ]; then rm -r @girs; fi
          source_root=$PWD
          mkdir -p .gir-generator/work templates
          ln -s ${gir_templates}/templates templates/templates
          cd .gir-generator/work
          ${pkgs.gjs}/bin/gjs -m ${gir_cli}/lib/ts-for-gir/bin/ts-for-gir-gjs generate '*' \
            --outdir "$source_root/@girs" --root "$source_root" -g ${gir_dirs}/share/gir-1.0 --ignoreVersionConflicts
          cd "$source_root"
          rm templates/templates
          rmdir templates .gir-generator/work .gir-generator
          test -f @girs/index.d.ts
          test -f tests/types-contract.ts
          test -f ${self.checks.${system}.native}/passed
          npm run typecheck
          runHook postBuild
        '';
        installPhase = ''
          mkdir -p $out
          touch $out/passed
        '';
      };
    };
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

        buildInputs = gir_packages ++ [pkgs.gjs];

        buildPhase = ''
          runHook preBuild
          bash style/compile/build.sh
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall

          install -Dm644 style/compile/main.css $out/share/${pname}/style/compile/main.css
          mkdir -p $out/bin $out/libexec

          ags bundle ${wallpaper_entry} $out/libexec/${pname}-wallpaper -g 4
          ags bundle ${entry} $out/bin/${pname} -g 4 \
            -d "WALLPAPER_BIN='$out/libexec/${pname}-wallpaper'" \
            -d "STYLE_DIR='$out/share/${pname}'"

          for launcher in $out/bin/${pname} $out/libexec/${pname}-wallpaper; do
            substituteInPlace "$launcher" \
              --replace-fail 'file="''${XDG_RUNTIME_DIR:-/tmp}/dmFyIF-ags.js"' "set -eo pipefail; umask 077; file=\$(mktemp \"\''${XDG_RUNTIME_DIR:-/tmp}/ags2-shell.XXXXXXXX\"); trap 'rm -f -- \"\$file\"' EXIT" \
              --replace-fail '> $file' '> "$file"' \
              --replace-fail '-m $file $@' '-m "$file" "$@"'
          done

          runHook postInstall
        '';

        preFixup = ''
          gappsWrapperArgs+=(
            --prefix PATH : "${pkgs.lib.makeBinPath runtime_programs}"
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
          runtime_programs
          ++ [
            (ags.packages.${system}.default.override {
              extraPackages = gir_packages;
            })
            pkgs.dart-sass
            pkgs.nodejs
            pkgs.typescript
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
