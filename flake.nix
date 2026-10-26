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
    typescript_api = "${pkgs.typescript_5}/lib/node_modules/typescript/lib/typescript.js";

    appmenu_glib_translator = pkgs.stdenv.mkDerivation {
      pname = "appmenu-glib-translator";
      version = "25.04-unstable-2026-10-12";

      src = "${pkgs.fetchFromGitLab {
        owner = "vala-panel-project";
        repo = "vala-panel-appmenu";
        rev = "1c47efa9fb8542e02aa5beb9dcb10fcf4fdae4ba";
        hash = "sha256-Yk13XIwv53UGYq/tIKW7W55nGIuiJpf3SW7OXSg3c0I=";
      }}/subprojects/appmenu-glib-translator";

      buildInputs = [pkgs.glib];
      nativeBuildInputs = with pkgs; [gobject-introspection meson pkg-config ninja vala];
    };

    tray = ags.packages.${system}.tray.overrideAttrs (old: {
      propagatedBuildInputs = map (input:
        if (input.pname or "") == "appmenu-glib-translator"
        then appmenu_glib_translator
        else input)
      old.propagatedBuildInputs;
    });

    # BUG: upstream AstalHyprland spins on a closed event socket instead of reconnecting.
    astal_hyprland = ags.packages.${system}.hyprland.overrideAttrs (old: {
      patches = (old.patches or []) ++ [./astal-hyprland-reconnect.patch];
    });

    astal_packages = with ags.packages.${system}; [
      io
      astal4
      battery
      apps
      astal_hyprland
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

    node_types = pkgs.runCommand "ags2-shell-node-types" {} ''
      mkdir -p $out/node_modules/@types/node $out/node_modules/undici-types
      tar -xzf ${pkgs.fetchurl {
        url = "https://registry.npmjs.org/@types/node/-/node-24.19.2.tgz";
        hash = "sha512-93d49wCWJkCyN87MxLpNN6KXPCwFw7bVUg79mGUV1OS40JGWwVCr8n61DXCSqz7CV6/VfPkb7xec7uP2M+QHWQ==";
      }} -C $out/node_modules/@types/node --strip-components=1
      tar -xzf ${pkgs.fetchurl {
        url = "https://registry.npmjs.org/undici-types/-/undici-types-7.24.6.tgz";
        hash = "sha512-WRNW+sJgj5OBN4/0JpHFqtqzhpbnV0GuB+OozA9gCL7a993SmU+1JBZCzLNxYsbMfIeDL+lTsphD5jN5N+n0zg==";
      }} -C $out/node_modules/undici-types --strip-components=1
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
    in
      pkgs.symlinkJoin {
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
      formatting = pkgs.stdenvNoCC.mkDerivation {
        name = "ags2-shell-formatting";
        src = ./.;
        nativeBuildInputs = with pkgs; [nodejs prettier alejandra shfmt shellcheck];
        buildPhase = ''
          npm run format:check
          npm run lint:shell
        '';
        installPhase = ''
          mkdir -p $out
          touch $out/passed
        '';
      };
      tests = pkgs.stdenvNoCC.mkDerivation {
        name = "ags2-shell-tests";
        src = ./.;
        nativeBuildInputs = with pkgs; [
          nodejs
          bash
          dart-sass
          diffutils
          procps
          util-linux
          which
          coreutils
          gjs
          xvfb-run
          gobject-introspection
          sway-unwrapped
          wl-clipboard
          dbus
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
          test -f tests/scripts/options.test.ts
          test -f tests/scripts/dev.test.ts
          test -f tests/scripts/style.test.ts
          test -f tests/scripts/bundle.test.ts
          export BUNDLED_MAIN=${self.packages.${system}.default}/bin/.${pname}-wrapped
          export BUNDLED_WALLPAPER=${self.packages.${system}.default}/libexec/.${pname}-wallpaper-wrapped
          export SWAY_HEADLESS_BIN=${pkgs.sway-unwrapped}/bin/sway
          export AGS2SHELL_TYPESCRIPT=${typescript_api}
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
          nodejs
          typescript
          gjs
          gobject-introspection
          bash
          coreutils
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
          test -f tests/types_contract.ts
          test -f ${self.checks.${system}.native}/passed
          export AGS2SHELL_NODE_TYPES=${node_types}/node_modules
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

        dontBuild = true;

        installPhase = ''
          runHook preInstall
          PREFIX=$out bash scripts/install-native.sh
          runHook postInstall
        '';

        preFixup = ''
          gappsWrapperArgs+=(
            --prefix PATH : "${pkgs.lib.makeBinPath runtime_programs}"
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
            pkgs.prettier
            pkgs.alejandra
            pkgs.shfmt
            pkgs.shellcheck
            pkgs.inotify-tools
          ];

        shellHook = ''
          export GIO_EXTRA_MODULES=${pkgs.gvfs}/lib/gio/modules
          export AGS2SHELL_STYLES=$PWD
          export AGS2SHELL_NODE_TYPES=${node_types}/node_modules
          export AGS2SHELL_TYPESCRIPT=${typescript_api}
        '';
      };
    };
  };
}
