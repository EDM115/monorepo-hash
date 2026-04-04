# monorepo-hash changelog

## v2.2.0
### Breaking changes
💥✨⚡️ feat/perf : the bundled binary is made with Go. beta, more details to come later. check [#25](https://github.com/EDM115/monorepo-hash/pull/25)

## v2.1.1
### Breaking changes
💥🩹 small fix : not providing any argument will display the help instead of exiting with code `2`  
🐛 fix : properly resolve the arm64 version of the binary on Windows

✨ feat : add a `--version`/`-v` flag to display the version information and exit so [WinGet doesn't complain](https://github.com/microsoft/winget-pkgs/pull/346996#issuecomment-4034397380)  
✨ feat : if the binary couldn't be downloaded during the `postinstall` step, replace its file with the JS implementation. note that the `postinstall` script still need to be ran, this is just here in case your platform isn't supported, the download fails or the script couldn't obtain the package version. if you blocked the `postinstall` script or just didn't let it run, you should still use the `monorepo-hash-js` entrypoint. note that this is a band-aid that won't work when using Windows + non-node_modules package manager  
🐛 fix : ensure the `postinstall` script doesn't run on dev  
📦️ build : binaries are built with Bun `1.3.11` instead of `1.3.10`  
📝 docs : add the WinGet manifests to the repo  
📝 docs : add WinGet installation instructions  
✅ tests : fix async leaks  
♻️ refactor : move files around to better separate Node & Bun versions, in order to welcome future potential implementations (ex Go & Rust)  
🔨🧑‍💻 scripts, dev : add a unified build script  
⬆️ deps : bump all deps

**Full Changelog**: https://github.com/EDM115/monorepo-hash/compare/2.1.0...2.1.1

### v2.1.0
✨ feat : add a `--nopathcache`/`-npc` flag to disable the path existence cache, which can make the process slightly slower but can reduce memory footprint on large monorepos  
✨ feat : the Bun build is now also available for Windows on ARM64  
⚡️ perf : use Bun's implementation of YAML parsing for the binary version  
⚡️🏗️ perf, internal : switch dependencies with leaner alternatives, courtesy of [e18e.dev](https://e18e.dev/). no difference should be visible user-side, hashes should stay the same, 219 => 173 deps. however if you see any change (apart from faster execution 😉), [open an issue](https://github.com/EDM115/monorepo-hash/issues/new?template=BUG_REPORT.yml)  
⚡️ perf : make the proto-less objects potentially even faster, props to https://github.com/h3js/rou3/blob/f0361df69be0aea4bea3ccb38ac7b5f7de78f342/src/_utils.ts and https://github.com/Kikobeats/null-prototype-object  
📦️ build : binaries are built with Bun `1.3.10` instead of `1.3.4`  
📦️ build : the produced JS code is downleveled to Node `22` instead of `20`  
📦️ build : Windows binaries now have proper properties  
🍱 assets : invert the order of resolutions in the ICO file to ensure that Bun picks the highest one, remove the 1024px variant  
🔨🧑‍💻 scripts, dev : add a script to compute the fixed benchmark times of an unreleased version  
🔧 config : use the newest OxLint config file format and update linters configs  
🔧 config : add the `inlinedDependencies` field  
📝 docs : update the badges  
📝 docs : add the benchmark history files to the repo  
📌 deps : pin Node to latest non-LTS (`v25`)  
⬆️ deps : bump all deps

**Full Changelog**: https://github.com/EDM115/monorepo-hash/compare/2.0.0...2.1.0

## v2.0.0
> [!IMPORTANT]  
> This will likely be the last release of `monorepo-hash`.  
> I consider the project to be feature-complete by now.  
> Future patch releases will only exist for performance improvements or dependency updates.  
> Future minor releases will only exist for bug fixes and potentially features.

### Breaking changes
💥✨⚡️ feat/perf : the Bun binary is now made the default, accessed with the `monorepo-hash` command. the pure Node version is still available either from the `monorepo-hash-js` command or the programmatic API, with the same exports than before  
💥✨⚡️🗑️ feat/perf/deprecate : the unified mode is now the default. this means faster runs and less VCS clutter. to revert to the older behavior, use the `--workspaces`/`-w` flag. to migrate, while on the older version delete every `.hash` file and run `pnpm monorepo-hash -g -u`. the `--unified`/`-u` flag has been removed  
💥🚑️ hotfix : the Bun version no longer produce different hashes due to a mistake in the `CryptoHasher` initialization  
💥🩹🔊 small fix/logs : the logged/returned paths are always POSIX-style

✨ feat : circular dependencies detection, will error out with code `6` if found  
🐛 fix : generating targeted hashes on unified mode won't delete existing hashes from workspaces outside of the specified targets  
🐛🔊 fix : properly respects silent mode for all logs and especially errors, no longer manually throws  
⚡️ perf : when computing the file hashes, properly process 100 in parallel instead of batches of 100  
⚡️ perf : pre-ignore hash files as well as node_modules and .git when getting the workspace files list  
⚡️ perf : only run path normalization on Windows  
⚡️ perf : properly get the available parallelism (CPU count) and minimum of 2 instead of 1  
⚡️ perf : cache the converted paths  
⚡️ perf : cache the existence of files  
⚡️ perf : optimize the transitive dependencies hashing  
⚡️ perf : load hash files in parallel, read them only once and avoid concurrency issues  
⚡️ perf : revert the change from `sort()` to `toSorted()` since the arrays benefited from being mutated in-place  
⚡️ perf : don't convert to POSIX when not needed  
⚡️ perf : reduce the amount of declared variables and objects  
⚡️ perf : avoid prototype chain lookups in hot paths  
⚡️ perf : use maps where possible for faster lookups  
⚡️ perf : cache the need to convert the path separator  
⚡️ perf : early exit from the files listing when no files are found  
⚡️ perf : don't even check for NPM's lockfile when it is the last option to check  
⚡️ perf : don't run superfluous exists checks + check PM lockfiles in parallel  
📝 docs : update the README with informations about the binary, the older usage, the default mode change and new flag, a better explanation of the transitive dep management, how to use the other exported file, refresh the examples and disclaimer on the benchmarks  
📝 docs : rework the Benchmarks table to accommodate for [#20](https://github.com/EDM115/monorepo-hash/issues/20)  
📦️ package : export functions and types from binary install and platform scripts in one endpoint  
♻️ refactor : move the `exists()` helper to the platform script to not pack `monorepo-hash` again inside, drastically reducing the postinstall script size and avoiding a crash on install  
🦺 types : lock in-place more things  
🦺 types : export the internal `Meta` type  
📦️ build : binaries are built with Bun `1.3.4` instead of `1.3.3`  
✅ tests : add utils, hash computation functions and edge cases tests  
✅ tests : reorganize tests  
✅ tests : update the tests to use POSIX-style paths  
✅ tests : update the tests to be conformant with the new default unified mode and change older tests to use the workspaces mode  
✅🩹 tests : no longer use `globalThis`  
👷 ci : also run benchmarks against a warm cache  
👷 ci : create a new Action for consistent benchmarks  
👷 ci : add a wide monorepo for benchmarks  
👷 ci : allow to use specific monorepos for benchmarks  
💡 docs : add missing functions documentation and unify it  
🔧 config : update the package keywords  
🔧 config : add missing folder to the TS config  
🔧 config : don't auto-update the exports and build types for the new endpoint  
🔨 scripts : fix the binaries test prepare script + enable PNPM shell emulation  
🎨 format : new format pass  
⬆️ deps : bump all deps

**Full Changelog**: https://github.com/EDM115/monorepo-hash/compare/1.9.0...2.0.0

---

## v1.9.0
> [!CAUTION]  
> The postinstall script will crash when run, you can ignore that. Upgrade to v2 asap !

🚑️🐛 hotfix : the binaries no longer segfault on platforms other than Windows as they are now built each directly in their target OS (see [#18](https://github.com/EDM115/monorepo-hash/issues/18)). binaries from [v1.8.0](#v180) have been rebuilt & republished since (except for `musl` variants which still crashes on that version)  
✨⚡️ feat/perf : the binaries now ship Bun-optimized code
  - separate file just for Bun
  - most Node functions (especially I/O ones) have been swapped to Bun native ones, which should improve peformance even further
  - some helper functions have been removed as well as docs, nothing is exported anymore since it's self-contained
  - the entrypoints and separate build steps have also been removed, reducing a bit the binaries file size

🔒️ security : releases are made immutables so no binary asset can be swapped at any point in time  
✅ tests : also test the behavior of the binary version  
🔥 build : remove the separate entrypoints  
🔧 config : no longer build separate entrypoints and drop the CJS version  
🔧 config : tweak the TS config

**Full Changelog**: https://github.com/EDM115/monorepo-hash/compare/1.8.0...1.9.0

---

## v1.8.0
✨⚡️ feat/perf : expose a new CLI entrypoint `monorepo-hash-bun`
  - this time you get a binary built with [Bun](https://bun.com/docs/bundler/executables), skipping the need for Node to be installed
  - enjoy faster startup times, lower memory usage and faster I/O operations
  - in exchange, the built files are massive since they contain Bun's runtime as well. to not bloat the package, the build corresponding to your platform is downloaded as a postinstall step
  - this version is for now totally optional
  - note : the file is called `monorepo-hash.exe` for the sole reason that I need a static filename and Windows requires binaries to end in `.exe` while Linux and MacOS don't care at all
  - binaries are built for the following targets (modern only, open an issue if you need support for baseline) :
    - Windows x64
    - Linux x64
    - Linux ARM64
    - MacOS x64
    - MacOS ARM64
    - Linux x64 MUSL (no bytecode compilation, cross-compiled from Windows)
    - Linux ARM64 MUSL (no bytecode compilation, cross-compiled from Windows)
  - the binaries are grabbed from the releases page of the matching monorepo-hash version on GitHub

🐛 fix : don't throw an error when using in a programmatic way and the exit code is 0  
🐛 fix : the postinstall script now properly runs for all package managers and don't rely on NPM internals  
🔥 qol : redeclare all deps as dev deps so they won't be resolved and installed in your node_modules 😉  
💡 docs : document the types as well  
📝 docs : document the release process  
📝 docs : add informations about the postinstall script  
📝 docs : add install and usage examples for Bun, NPM, Yarn and Deno  
✅ tests : verify the output from the non-CLI version  
👷 ci : also benchmark the Bun versions  
👷 ci : the benchmark exits after 45mins instead of 60 and runs in silent mode to save some CPU cycles  
🧑‍💻 dev : remove the entrypoint from the main file and create separate ESM/CJS entrypoints *(CJS is only used for Bun so it can do bytecode compilation)*  
🧑‍💻 dev : remove the prepublish script  
🔨 scripts : add bun build scripts  
🔨 scripts : add a platform detection script  
🔨 scripts : add the `postinstall` script that downloads the build corresponding to your platform  
🔨 scripts : create a decoy binary before packing the NPM package in order to properly link the final executable for NPM and Yarn  
🍱 assets : add an ICO file for the Windows executable  
🙈 ignore : don't track bun built files

**Full Changelog**: https://github.com/EDM115/monorepo-hash/compare/1.7.0...1.8.0

---

## v1.7.0
✨ feat : allow to use monorepo-hash outside of the cli with `runCli()`, pass it the args as you would in the terminal and it'll work the same !  
✨ feat : all of the core functions now return their results instead of void, making it easier to use them programmatically  
👷 ci : specify the package manager to skip their resolution and not skew the benchmark results  
✅ tests : the workspace detection is now tested properly with the exported functions  
⬆️ deps : bump tsdown  
📝 docs : added a text changelog

**Full Changelog**: https://github.com/EDM115/monorepo-hash/compare/1.6.0...1.7.0

---

## v1.6.0
> [!IMPORTANT]  
> **NPM, Yarn, Bun and Deno are now supported 🥳**  

✨ feat : add a new `--packagemanager`/`-pm` flag to specify other package managers to use than PNPM  
💥🚚 feat : exit code `5` (unexpected error) is now `99` to leave place for potential future ones  
✨ cli : the exit code `5` is now thrown when a specified package manager isn't present on the repo  
✅ tests : add tests for the package managers detection  
🎨 format : add region markers and reorder functions  
🎨 format : always use named imports in tests  
💡 docs : document every new function  
📝 docs : change the logo image to a lighter WEBP one  
🔥 docs : remove old versions of the logo  
📝 docs : tweak a bit the README  
⬇️ deps : lock tsdown out of beta  
🔧 config : tweak the TS config

**Full Changelog**: https://github.com/EDM115/monorepo-hash/compare/1.5.1...1.6.0

---

## v1.5.1
💥🎨 files : extensions renamed from `.js` to `.mjs` and `.d.ts` to `.d.mts`, potentially breaking if you imported them manually  
⚡️ perf : use `.toSorted()` instead of `.sort()` to not mutate in-place the arrays  
🎨 style : changed a bit the format  
✅ tests : print the import breakdown  
⬆️ deps : bumped all non-major dependencies  
📌 deps : pin Node to latest LTS (Krypton, v24)  
👷 ci : move the test action to a lighter image

**Full Changelog**: https://github.com/EDM115/monorepo-hash/compare/1.5.0...1.5.1

## v1.5.0
✨ feat : you can now have a singular hash file by using the `--unified`/`-u` flag. this also affects the debug mode. this wasn't made the default to stay backwards compatible  
⚡️ perf : checking if files exist should be marginally faster  
✅ tests : added tests for the unified mode  
📝 docs : better help description  
🔧 config : add the shebang dynamically at build time  
🎨 format : use named imports where possible  
⬆️ deps : bumped all non-major dependencies  
👷 ci : added the ability to run both tests and benchmarks on demand in PRs through labels  
🧑‍💻 dev : removed some recommended VS Code extensions

### What's Changed
* Aggregate hashes in root file by [@EDM115](https://github.com/EDM115) in https://github.com/EDM115/monorepo-hash/pull/11

**Full Changelog**: https://github.com/EDM115/monorepo-hash/compare/1.4.2...1.5.0

---

## v1.4.2
🐛 fix : no longer override debug hash files in debug + compare mode  
👷 ci : added a test for debug mode

### What's Changed
* Add debug mode tests by [@EDM115](https://github.com/EDM115) in https://github.com/EDM115/monorepo-hash/pull/6

**Full Changelog**: https://github.com/EDM115/monorepo-hash/compare/1.4.1...1.4.2

## v1.4.1
🩹 small fix : actually sort workspaces in output  
👷 ci : the benchmarks runs against a cold disk cache

**Full Changelog**: https://github.com/EDM115/monorepo-hash/compare/1.4.0...1.4.1

## v1.4.0
⚡️ perf : revert the file streaming added in [v1.2.0](https://github.com/EDM115/monorepo-hash/releases/tag/1.2.0) which caused a lot of overhead and divided by 2/3 the performance on worst case scenarios  
⚡️ perf : switch from `[].includes()` to `Set([]).has()`  
🎨 lint : removed ESLint (apart for formatting) and better OxLint config  
🧑‍💻 dev : added VS Code settings and recommended extensions

**Full Changelog**: https://github.com/EDM115/monorepo-hash/compare/1.3.1...1.4.0

---

## v1.3.1
🩹 small fix : sort workspaces in the output for consistent results  
✏️ typo : correct bin path in the `package.json`  
👷 ci : added a benchmarking CI

**Full Changelog**: https://github.com/EDM115/monorepo-hash/compare/1.3.0...1.3.1

## v1.3.0
🚀 perf : only compute hashes for the specified workspaces and their transitive dependencies when specifying target(s)  
✅ tests : enhance the output tests by checking the categories and more in-depth changed dependencies

### What's Changed
* Optimize target hashing by [@EDM115](https://github.com/EDM115) in https://github.com/EDM115/monorepo-hash/pull/9

**Full Changelog**: https://github.com/EDM115/monorepo-hash/compare/1.2.0...1.3.0

---

## v1.2.0
🚀 perf : pre-normalize paths  
🚀 perf : stream the files into the hash function instead of loading them fully in-memory  
🚀 perf : pre-allocate the array length

### What's Changed
* Improve hashing speed by [@EDM115](https://github.com/EDM115) in https://github.com/EDM115/monorepo-hash/pull/7

**Full Changelog**: https://github.com/EDM115/monorepo-hash/compare/1.1.0...1.2.0

---

## v1.1.0
🚀 perf : do not resolve the `package.json` files multiple times  
⬆️ deps : upgrade dependencies

### What's Changed
* chore: update config files \[skip ci] by [@EDM115](https://github.com/EDM115) in https://github.com/EDM115/monorepo-hash/pull/2
* Update hash() to await and return by [@EDM115](https://github.com/EDM115) in https://github.com/EDM115/monorepo-hash/pull/3
* Cache package.json manifest during hash generation by [@EDM115](https://github.com/EDM115) in https://github.com/EDM115/monorepo-hash/pull/4

### New Contributors
* [@EDM115](https://github.com/EDM115) made their first contribution in https://github.com/EDM115/monorepo-hash/pull/2

**Full Changelog**: https://github.com/EDM115/monorepo-hash/compare/1.0.0...1.1.0

---

## v1.0.0
## Initial stable release of `monorepo-hash`

### Commits
- [7ce18d71c8ba8d01944441fe18af0413ae3a4280](https://github.com/EDM115/monorepo-hash/commit/7ce18d71c8ba8d01944441fe18af0413ae3a4280) : Initial commit
- [1cfcdd81e6b4a3c293988001e35235839c75af73](https://github.com/EDM115/monorepo-hash/commit/1cfcdd81e6b4a3c293988001e35235839c75af73) : v0.1.0: working but not usable as a package
- [ddc0bba7f956a1945550a264bbed470993883643](https://github.com/EDM115/monorepo-hash/commit/ddc0bba7f956a1945550a264bbed470993883643) : publish under my name to avoid an existing package
- [9c1d12bfe4367521aaf1880fb206bca18fce76af](https://github.com/EDM115/monorepo-hash/commit/9c1d12bfe4367521aaf1880fb206bca18fce76af) : why did I used the wrong name ?
- [e272e983d1595aefabec4970ba627a6d223153c5](https://github.com/EDM115/monorepo-hash/commit/e272e983d1595aefabec4970ba627a6d223153c5) : 0.2.0, fixed wrong char during copy
- [5fe59b6ef455a0c6d6daa6fe4ae01a54127df5d2](https://github.com/EDM115/monorepo-hash/commit/5fe59b6ef455a0c6d6daa6fe4ae01a54127df5d2) : feat(0.3.0): works in environnements without a TTY (ex VS Code's Source Control view)
- [d39042e6a1b361ebbed5c2c2c3bf970fab192f20](https://github.com/EDM115/monorepo-hash/commit/d39042e6a1b361ebbed5c2c2c3bf970fab192f20) : chore(0.4.0): prepare for real release
- [3c83d7fd014282376cc94c0a3bfa563f03deedaa](https://github.com/EDM115/monorepo-hash/commit/3c83d7fd014282376cc94c0a3bfa563f03deedaa) : fix: builds
- [97013a8c3782004c3419ef5420b9e3c3381a8755](https://github.com/EDM115/monorepo-hash/commit/97013a8c3782004c3419ef5420b9e3c3381a8755) : feat(0.4.0): no more warnings and bundle the deps
- [32548fb1b21cdd58aecb143482ab829ba351e1a6](https://github.com/EDM115/monorepo-hash/commit/32548fb1b21cdd58aecb143482ab829ba351e1a6) : prepare readme
- [d34ad11ebd2f715e1c597a9b213deb0f4b1bd96a](https://github.com/EDM115/monorepo-hash/commit/d34ad11ebd2f715e1c597a9b213deb0f4b1bd96a) : fix(0.6.0): actual progression and doesn't goes to total directly
- [63112fa20171a7f21b0eea71d17e815c440bcbf5](https://github.com/EDM115/monorepo-hash/commit/63112fa20171a7f21b0eea71d17e815c440bcbf5) : chore(0.6.1): export functions and types
- [109f3b58c43be97150665fe78bbca76004125546](https://github.com/EDM115/monorepo-hash/commit/109f3b58c43be97150665fe78bbca76004125546) : feat(0.7.0): adds correct tests
- [f76e762265f0af58d3fa350971457de41d6d93d8](https://github.com/EDM115/monorepo-hash/commit/f76e762265f0af58d3fa350971457de41d6d93d8) : chore: add logo
- [9ad6222fdd1e43d7cce2f696cca66d15ceb40baf](https://github.com/EDM115/monorepo-hash/commit/9ad6222fdd1e43d7cce2f696cca66d15ceb40baf) : feat(0.8.0): some documentation + unique error codes
- [c1cabd00e3eea9843e21df19b767540be1b1fd0a](https://github.com/EDM115/monorepo-hash/commit/c1cabd00e3eea9843e21df19b767540be1b1fd0a) : chore: add small-monorepo demo (509 files)  
  + ignore them from ts and lints
- [c5722a817f08f3b6c86f3075c105bc94581bf758](https://github.com/EDM115/monorepo-hash/commit/c5722a817f08f3b6c86f3075c105bc94581bf758) : fix: don't break when processing thousand files (batch of 50) and fix padding of numbers depending on workspaces count  
  also fix a wrong error code
- [348c4c0b66a04926491d5469d713ad198dd955e4](https://github.com/EDM115/monorepo-hash/commit/348c4c0b66a04926491d5469d713ad198dd955e4) : chore: add medium-monorepo (50 014 files)
- [99700f952259f5e023aef665dc567b4e7e8971cd](https://github.com/EDM115/monorepo-hash/commit/99700f952259f5e023aef665dc567b4e7e8971cd) : chore: remove plain demos
- [58216966606fd6eb356d1567ada5d1d763c14c0d](https://github.com/EDM115/monorepo-hash/commit/58216966606fd6eb356d1567ada5d1d763c14c0d) : chore: readd the demos as archives
- [bfa63cf7310a86699af2e460b8d6eef2d56daad5](https://github.com/EDM115/monorepo-hash/commit/bfa63cf7310a86699af2e460b8d6eef2d56daad5) : fix: bump the concurrency count to 100 and log before we start processing to not get stuck on huge workspaces only
- [27395ffef6ec4b4c03d3a5e0a936f9f143f47c47](https://github.com/EDM115/monorepo-hash/commit/27395ffef6ec4b4c03d3a5e0a936f9f143f47c47) : docs: add benchmarks and output examples
- [a25babaf1536d136c31674275a7d5daadf043ee2](https://github.com/EDM115/monorepo-hash/commit/a25babaf1536d136c31674275a7d5daadf043ee2) : docs: reduce the examples size and fix some of them
- [b0390418ae301fecf13593379f1c1e9ad32eddba](https://github.com/EDM115/monorepo-hash/commit/b0390418ae301fecf13593379f1c1e9ad32eddba) : docs: better formatting for benchmarks
- [3a7e32666a84bcc1129aef4688c810ceca51f348](https://github.com/EDM115/monorepo-hash/commit/3a7e32666a84bcc1129aef4688c810ceca51f348) : docs: add CI example
- [ad6c1d75d9fa8a2312981d34223f80010acdd787](https://github.com/EDM115/monorepo-hash/commit/ad6c1d75d9fa8a2312981d34223f80010acdd787) : chore(docs): typos
- [5a626628d5eff4f7102b5ff8380664c41f523410](https://github.com/EDM115/monorepo-hash/commit/5a626628d5eff4f7102b5ff8380664c41f523410) : chore: release 0.9.0  
  only more tests remains before 1.0
- [86fec0729175a14c01844c4e74a2e8e2ef7ee108](https://github.com/EDM115/monorepo-hash/commit/86fec0729175a14c01844c4e74a2e8e2ef7ee108) : chore: spacing
- [7b2ec44adee2203d5ffae246150eebaaa6a3bf44](https://github.com/EDM115/monorepo-hash/commit/7b2ec44adee2203d5ffae246150eebaaa6a3bf44) : chore: new logo and add all attempts
- [30b715b2740cd444ab5386690c3b80fa976a76eb](https://github.com/EDM115/monorepo-hash/commit/30b715b2740cd444ab5386690c3b80fa976a76eb) : chore: move the image location since GitHub caches aggressively
- [8931b0fd0f0320bbf637d75a0caf10cf688d5a08](https://github.com/EDM115/monorepo-hash/commit/8931b0fd0f0320bbf637d75a0caf10cf688d5a08) : chore: docs
- [f3b775e118f9e374165475af55a4bf448e2c5b3d](https://github.com/EDM115/monorepo-hash/commit/f3b775e118f9e374165475af55a4bf448e2c5b3d) : docs: adds who uses it section
- [cc1375611367f88835847a15f95aa922cbc34d81](https://github.com/EDM115/monorepo-hash/commit/cc1375611367f88835847a15f95aa922cbc34d81) : feat(tests): add a real complete test suite
- [698e72f6ce827eedf5dafc144c325a5cf80fd2e3](https://github.com/EDM115/monorepo-hash/commit/698e72f6ce827eedf5dafc144c325a5cf80fd2e3) : chore: release 1.0.0

**Full Changelog**: https://github.com/EDM115/monorepo-hash/commits/1.0.0
