{
  description = "Prime Agent";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    nixpkgs-darwin.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
  };

  outputs =
    {
      nixpkgs,
      nixpkgs-darwin,
      ...
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forEachSystem = nixpkgs.lib.genAttrs systems;
      nixpkgsFor = system: if builtins.elem system [ "aarch64-darwin" ] then nixpkgs-darwin else nixpkgs;

      mkSystem =
        system:
        let
          pkgs = (nixpkgsFor system).legacyPackages.${system};
          nodejs = pkgs.nodejs;
          isLinux = pkgs.stdenv.hostPlatform.isLinux;
          runtimePath = [
            nodejs
            pkgs.bash
            pkgs.fd
            pkgs.git
            pkgs.ripgrep
            pkgs.gnutar
            pkgs.uv
            pkgs.python311
          ]
          ++ pkgs.lib.optionals isLinux [ pkgs.xdg-utils ];

          # The zeromq npm package ships prebuilt native addons, so the addon is built
          # from source against nixpkgs' libzmq instead.
          projectOptions = pkgs.fetchzip {
            url = "https://github.com/aminya/project_options/archive/refs/tags/v0.41.0.zip";
            hash = "sha256-qZusLCSdzHHQ7XN7wGcroWGyDvNVYphojbTUre0od7s=";
          };

          cmakeTsOptions = builtins.toJSON {
            "cmake-ts" = {
              cmakeOptions = [
                {
                  name = "FETCHCONTENT_SOURCE_DIR__PROJECT_OPTIONS";
                  value = "$ROOT$/project_options";
                }
              ]
              ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin [
                {
                  name = "MACOSX_DEPLOYMENT_TARGET";
                  value = "10.15";
                }
              ];
            };
          };

          prime-agent = pkgs.buildNpmPackage (finalAttrs: {
            pname = "prime-agent";
            version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
            __structuredAttrs = true;
            src = ./.;

            # Bootstrap runs `uv python install 3.11` explicitly when no
            # venv exists yet (bootstrap.ts), which downloads a Python that is
            # never used because the venv is created with the Python provided by nix
            # (UV_PYTHON_PREFERENCE=system). Drop the redundant download.
            # When merged into nixpkgs, swap for ${nixpkgs}/pkgs/by-name/pr/prime-agent/remove-uv-python-install.patch
            patches = [
              (pkgs.writeText "remove-uv-python-install.patch" ''
                --- a/packages/coding-agent/src/core/kernel/bootstrap.ts
                +++ b/packages/coding-agent/src/core/kernel/bootstrap.ts
                @@ -730,7 +730,6 @@
                 	const runtimeRequirement = sourceDir ?? RUNTIME_REQUIREMENT;
                 	const runtimeIdentity = await resolveRuntimeIdentity();
                ${""}
                -	await run(uv, ["python", "install", PYTHON_VERSION]);
                 	await run(uv, ["venv", venv, "--python", PYTHON_VERSION, "--seed"]);
                 	await run(uv, [
                 		"pip",
              '')
            ];

            inherit nodejs;
            npmDepsFetcherVersion = 2;
            npmDepsHash = "sha256-1sLVGKQmMfOW2hUNlxf2d2fjdd5EcqFZdhc0y6Wk0X8=";
            # The upstream lockfile omits registry metadata for workspace dependencies.
            npmDeps = pkgs.fetchNpmDeps {
              name = "prime-agent-npm-deps";
              src = ./.;
              fetcherVersion = 2;
              hash = finalAttrs.npmDepsHash;
              nativeBuildInputs = [ pkgs.npm-lockfile-fix ];
              postPatch = ''
                ${pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isDarwin "export REQUESTS_CA_BUNDLE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"}
                npm-lockfile-fix package-lock.json
              '';
            };

            # The zeromq addon is built from source in buildPhase; don't let `npm rebuild`
            # touch install scripts (they would try to load the shipped prebuilt addons,
            # which are broken on aarch64-darwin, or attempt a networked build).
            npmRebuildFlags = [ "--ignore-scripts" ];

            nativeBuildInputs = [
              pkgs.cmake
              pkgs.jq
              pkgs.makeWrapper
              pkgs.ninja
              pkgs.pkg-config
            ]
            ++ pkgs.lib.optionals isLinux [ pkgs.autoPatchelfHook ];
            buildInputs = [
              pkgs.cairo
              pkgs.pango
              # The npm addon is compiled with zeromq's draft APIs enabled (upstream
              # default) and references draft symbols, so the libzmq it links against
              # must have them too; otherwise the addon fails to load.
              (pkgs.zeromq.override { enableDrafts = true; })
            ];

            postPatch = ''
              cp ${finalAttrs.npmDeps}/package-lock.json package-lock.json
            '';
            dontConfigure = true;
            # Build the workspace packages explicitly because the root package is not the CLI.
            dontNpmBuild = true;
            buildPhase = ''
              runHook preBuild

              export PATH="$PWD/node_modules/.bin:$PATH"
              npm --workspace packages/tui run build
              (cd packages/ai && tsgo -p tsconfig.build.json)
              npm --workspace packages/agent run build
              npm --workspace packages/coding-agent run build

              # Build the zeromq native addon from source against nixpkgs' libzmq;
              # Strip the vcpkg call (which would fetch and build its own libzmq)
              # and let zeromq's own cmake-ts build do the rest, fully offline.
              sed -i '/run_vcpkg/,/)/d' node_modules/zeromq/CMakeLists.txt
              mkdir -p node_modules/zeromq/project_options
              cp -r ${projectOptions}/. node_modules/zeromq/project_options/
              ${pkgs.lib.toShellVar "cmakeTsOptions" cmakeTsOptions}
              jq --argjson opts "$cmakeTsOptions" '. * $opts' \
                node_modules/zeromq/package.json > node_modules/zeromq/package.json.tmp
              mv node_modules/zeromq/package.json.tmp node_modules/zeromq/package.json

              # cmake-ts downloads node headers; give it nixpkgs' instead.
              nodever=$(node -p process.versions.node)
              os=$(node -p process.platform)
              arch=$(node -p process.arch)
              mkdir -p "$HOME/.cmake-ts/node/$os/$arch/v$nodever/include"
              cp -r ${nodejs}/include/node "$HOME/.cmake-ts/node/$os/$arch/v$nodever/include/"
              export CMAKE_PREFIX_PATH="$NIXPKGS_CMAKE_PREFIX_PATH"

              # Drop the shipped prebuilt addons so the loader only finds our build.
              rm -rf node_modules/zeromq/build/*/
              (cd node_modules/zeromq && npm_config_build_from_source=true node script/install.js)
              rm -rf node_modules/zeromq/staging node_modules/zeromq/compile_commands.json

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              npm prune --omit=dev --ignore-scripts
              packageDir=$out/lib/prime-agent
              mkdir -p "$packageDir" $out/bin
              cp -R node_modules "$packageDir/node_modules"
              rm -rf "$packageDir/node_modules/koffi"
              cp packages/coding-agent/package.json "$packageDir/package.json"
              cp -R packages/coding-agent/dist "$packageDir/dist"
              for path in README.md CHANGELOG.md docs examples skills; do
                cp -R "packages/coding-agent/$path" "$packageDir/$path"
              done

              mkdir -p "$packageDir/packages"
              for workspace in ai agent tui coding-agent; do
                mkdir -p "$packageDir/packages/$workspace"
                cp "packages/$workspace/package.json" "$packageDir/packages/$workspace/package.json"
                cp -R "packages/$workspace/dist" "$packageDir/packages/$workspace/dist"
              done
              for path in docs examples skills; do
                cp -R "packages/coding-agent/$path" "$packageDir/packages/coding-agent/$path"
              done

              # The venv is created with the Python provided by nix (UV_PYTHON_PREFERENCE=system).
              # UV_PYTHON_DOWNLOADS=manual stops any surprise Python downloads.
              makeWrapper ${pkgs.lib.getExe nodejs} $out/bin/prime-agent \
                --add-flags "$packageDir/dist/bundle/cli.js" \
                --set PI_PACKAGE_DIR "$packageDir" \
                --set PI_SKIP_VERSION_CHECK 1 \
                --set UV_PYTHON_PREFERENCE system \
                --set UV_PYTHON_DOWNLOADS manual \
                --prefix PATH : ${pkgs.lib.makeBinPath runtimePath} \
                ${pkgs.lib.optionalString isLinux "--prefix LD_LIBRARY_PATH : ${
                  pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]
                }"}

              runHook postInstall
            '';

            doInstallCheck = true;
            nativeInstallCheckInputs = [ pkgs.versionCheckHook ];
            versionCheckProgramArg = "--version";

            installCheckPhase = ''
              runHook preInstallCheck

              # Verify the Python version matches what the source code requires
              requiredPythonVersion=$(grep -oP 'PYTHON_VERSION = "\K[^"]+' \
                packages/coding-agent/src/core/kernel/bootstrap.ts)
              actualVersion=$(${pkgs.lib.getExe pkgs.python311} -c 'import sys;print("%d.%d"%sys.version_info[:2])')
              if [ "$actualVersion" != "$requiredPythonVersion" ]; then
                echo "ERROR: prime-agent requires Python $requiredPythonVersion but $actualVersion provided"
                exit 1
              fi

              runHook postInstallCheck
            '';

            meta = {
              description = "Self-improving RLM coding and research agent";
              homepage = "https://github.com/PrimeIntellect-ai/prime-agent";
              changelog = "https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v${finalAttrs.version}";
              license = pkgs.lib.licenses.mit;
              maintainers = [ pkgs.lib.maintainers.okwilkins ];
              mainProgram = "prime-agent";
              platforms = [
                "aarch64-linux"
                "x86_64-linux"
                "aarch64-darwin"
              ];
              sourceProvenance = with pkgs.lib.sourceTypes; [ fromSource ];
            };
          });
        in
        {
          package = prime-agent;
        };
      perSystem = forEachSystem mkSystem;
    in
    {
      packages = forEachSystem (system: {
        default = perSystem.${system}.package;
      });
      apps = forEachSystem (system: {
        default = {
          type = "app";
          program = "${perSystem.${system}.package}/bin/prime-agent";
          meta.description = "Self-improving RLM coding and research agent";
        };
      });
      checks = forEachSystem (system: {
        default = perSystem.${system}.package;
      });
    };
}
