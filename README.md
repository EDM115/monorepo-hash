<div align="center">

# monorepo-hash
**A CLI tool to generate hashes for the workspaces of your monorepo**

<img src="https://raw.githubusercontent.com/EDM115/monorepo-hash/refs/heads/master/logo.webp" alt="monorepo-hash logo" width="200" height="200">

![NPM Version](https://img.shields.io/npm/v/monorepo-hash) ![NPM Downloads](https://img.shields.io/npm/dt/monorepo-hash) ![Total binaries downloads](https://img.shields.io/github/downloads/EDM115/monorepo-hash/total?label=Total%20binaries%20downloads) ![More info](https://img.shields.io/badge/npmx-More_info-orange?logo=npm&link=https%3A%2F%2Fnpmx.dev%2Fpackage%2Fmonorepo-hash)

## :memo: Features
:runner: **Fast** : Runs in huge monorepos [in no time](#rocket-benchmarks), processes workspaces in parallel, powered by Bun  
:dart: **Accurate** : Generates hashes based on every tracked file  
:left_right_arrow: **Complete** : Supports transitive workspace dependencies  
:ok_hand: **No config** : Drop-in and instantly usable  
:man_juggling: **Versatile** : Works with PNPM, Bun, Yarn, NPM and Deno  
:computer: **Cross-platform** : Works on Windows, Linux and macOS  
:hash: **Deterministic** : Same input, same output  
:package: **Lightweight** : No bloat, just the essentials

</div>

## :thinking: Why
When you're working with monorepos, there's often a lot of workspaces (packages) that end up being created.  
And as your project grows, so does the number of workspaces (and so does your build times...).  
If you ever worked with stuff like Next.js, you know what I'm talking about. And since every workspace requires another, you need everything to be built to test your changes.

Although there are tools that allow your scripts to run only when files have changed (ex `turbo`), the complete CI step cannot benefit from this. For example with `turbo` again, they allow you to prune just the right workspaces and dependencies when building in a Docker, but this requires copying the entire monorepo into the container so we can't benefit from Docker's layers caching.  
If only there could be a way to determine if a workspace hasn't changed to not rebuild it for nothing...

Well lucky you, `monorepo-hash` is here to help with that !

> [!NOTE]
> `monorepo-hash` was created when I was doing my internship at Nexelec.  
> I really put a lot of energy in this script so I decided to release `monorepo-hash` as a standalone CLI tool to help anyone struggling with this problem !

## :beginner: Usage
### Installation
You can install `monorepo-hash` globally, but it's best to add it as a dev dependency at the root of your monorepo :
```bash
pnpm add -D monorepo-hash --allow-build=monorepo-hash
# or bun, yarn, npm, deno
# monorepo-hash was originally made with only PNPM in mind, open an issue if you encounter any problem
bun add -D monorepo-hash --trust
yarn add -D monorepo-hash
npm install -D monorepo-hash
# add "nodeModulesDir": "auto" to your deno.json(c) config file first
deno install -D npm:monorepo-hash --allow-scripts=npm:monorepo-hash
```
> [!IMPORTANT]  
> Since `v2.0.0`, the `monorepo-hash` cli command is a direct binary made with Bun that cut the Node.js overhead and enables faster I/O. To enable this, the postinstall script needs to be run, which is disabled by default in PNPM/Bun/Deno for security reasons.  
> You can totally refuse to use it (whether it is for security reasons or size constraints). In such case, either run the older Node + plain JS version (`monorepo-hash-js`) or use the [programmatic API](#usage-outside-of-the-cli).  
> If you added `monorepo-hash` without allowing the postinstall script to run, you can do it later at anytime with `pnpm approve-scripts`, `bun pm trust monorepo-hash` or `deno approve-scripts`.

> [!TIP]  
> Make sure that your workspace configuration is set up correctly (`pnpm-workspace.yaml`, `package.json` workspaces or `deno.json(c)` workspace) as `monorepo-hash` will use it to find your workspaces. Globs are supported.  
> Make sure that your lockfiles are present as well since they are used to detect the used package manager. To skip this resolution step, use the `--packagemanager` argument to force one.  
> To detect internal transitive dependencies, `monorepo-hash` will check the deps of each of the packages included in the workspaces configs. This allows it to work regardless of the package manager's standard (simple version, `workspace:` protocol or direct `file:` links).  
> Finally, it will generate a single root `.hash` file that you would need to keep in your VCS in order for it to be efficient (ex : to be reused in your CI). This is made to not clutter your filesystem and VCS, especially if you have a lot of packages, however if you prefer to have per-workspace `.hash` files, use the `--workspaces` mode.

### Get help
```bash
pnpm monorepo-hash --help
# or bun, yarn, npm, deno
bunx monorepo-hash --help
yarn run monorepo-hash --help
npx monorepo-hash --help
dx monorepo-hash --help
```
> [!TIP]  
> Short versions of all arguments are also available.

### Generate hashes for your entire monorepo
```bash
pnpm monorepo-hash --generate
```

### Generate hashes for specific workspaces
Specify them in quotes, separated by commas, no spaces, and with no leading or trailing slashes.  
The target name is the path to the workspace relative to the root of your monorepo, and uses forward slashes no matter your platform.
```bash
pnpm monorepo-hash --generate --target="packages/example,services/ui"
```

### Compare hashes
```bash
pnpm monorepo-hash --compare
```

### Compare hashes for specific workspaces
Same rules apply.
```bash
pnpm monorepo-hash --compare --target="packages/example"
```

### Run in silent mode
This will suppress all output. This can be useful for example in CI where only the exit code matters.
```bash
pnpm monorepo-hash --compare --silent
```

### Usage outside of the CLI
You can also use `monorepo-hash` programmatically in your own scripts.  
Whether it's because there's some utilities that are interesting or because you prefer to integrate it in your scripts, you can just import about any function or type from `monorepo-hash`.  
The main functionality stems from `runCli()`, check the autocomplete of your IDE to see the available functions/types, all with some documentation associated with them.
```ts
import monorepoHash, { exists } from "monorepo-hash"
// runCli is a default export as well

import { download, detectLibcFamily } from "monorepo-hash/install-binary"
// additional functions live here
// tip : if you only need the `exists` function, import it from here instead to reduce bundle size

// ...
async function checkFiles() {
  // logic...
  for (file in files) {
    const existsResult = await exists(file)

    if (existsResult) {
      // do something...
    }
  }
}

// ...
async function dlThings() {
  const url = "https://example.com/somefile"
  const dest = "./somefile"

  await download(url, dest)
  const libc = await detectLibcFamily()
  // do something with it...
}

// ...
async function checkHashes() {
  const compareResult = await monorepoHash(["--compare", "--target=packages/example"])
  // do something with it...
}
```

### Run in debug mode
The debug mode will :
- in generate mode, output a root `.debug-hash` file which will contain the hashes of each individual file in the workspace as a JSON object (or per-workspace files when using `--workspaces`)
- in compare mode, read those `.debug-hash` file(s) and tell you *exactly* which files have changed in each workspace, and what their hashes are
This can be useful to check why the hashes appear to be different, or to debug issues with the hashes generation.
```bash
pnpm monorepo-hash --generate --debug
# later on...
pnpm monorepo-hash --compare --debug
```
Don't forget to delete these files afterwards !

### Exit codes
- `0` : No changes detected (or you wanted to get help)
- `1` : Changes detected in the hashes
- `2` : Error with the arguments (either `--generate` or `--compare` is missing, both were provided or an unsupported `--packagemanager` was forced)
- `3` : Unknown arguments provided
- `4` : No workspaces found or unsupported package manager
- `5` : Package manager forced with `--packagemanager` not present in the repo
- `6` : Circular dependency detected in the workspace packages
- `99` : An unexpected error occurred, please open an issue with the logs

## :test_tube: Examples
### Outputs
Tested in the [small monorepo](tests/demo/small-monorepo.7z), with the following directory structure :
```
.
├── database
├── packages
│   ├── cli-tools
│   └── linter
├── services
│   ├── backend
│   └── frontend
└── pnpm-workspace.yaml
```

<details><summary><h4>Hash generation</h4></summary>

```bash
$ pnpm monorepo-hash --generate
ℹ️ Generating hashes for all workspaces...

ℹ️ Using pnpm workspaces from C:\Users\EDM115\Desktop\test\small-monorepo

✅ Computed all hashes (5)

✅ database (34e5c3bb9a1545fcc7eab03d439bfe79abe1b12ebb0d2c7cdacb1744e58ab22a written to .hash)
✅ packages/cli-tools (b0b7271f403749b906dec2405e6127c58c2d267695a6d84bc96f1a2918fb0d07 written to .hash)
✅ packages/linter (aa37077b2c0034ce44a074d8a46778153cf51b1125e2623364de272d1b640bd6 written to .hash)
✅ services/backend (1aa3f39996e526e3f530943f2d0081cde30efabc643af64ba95d157b0072c463 written to .hash)
✅ services/frontend (7251bacb2abaec585b7faa4ea56c9c74a8b7ed20422255a72442bfa7ce7dbb71 written to .hash)
```

</details>

<details><summary><h4>Hash comparison - no changes</h4></summary>

```bash
$ pnpm monorepo-hash --compare
ℹ️ Comparing hashes for all workspaces...

ℹ️ Using pnpm workspaces from C:\Users\EDM115\Desktop\test\small-monorepo

✅ Computed all hashes (5)

✅ Unchanged (5) :
• database
• packages/cli-tools
• packages/linter
• services/backend
• services/frontend
```

</details>

<details><summary><h4>Hash comparison - changes detected</h4></summary>

```bash
$ pnpm monorepo-hash --compare
ℹ️ Comparing hashes for all workspaces...

ℹ️ Using pnpm workspaces from C:\Users\EDM115\Desktop\test\small-monorepo

✅ Computed all hashes (5)

⚠️ Changed (5) :
• database
        old : 34e5c3bb9a1545fcc7eab03d439bfe79abe1b12ebb0d2c7cdacb1744e58ab22a
        new : b10e0b4af3f4d25033e3116ffed89a6d73873b4238d27bcf48cf87318b701cf6
        🚧 changed dependency(s) :
                • packages/linter
• packages/cli-tools
        old : b0b7271f403749b906dec2405e6127c58c2d267695a6d84bc96f1a2918fb0d07
        new : 0b42cd27826f37213e54535ff9f32808fc673b256a4bec1ce0288d8c02886f73
        🚧 changed dependency(s) :
                • packages/linter
• packages/linter
        old : aa37077b2c0034ce44a074d8a46778153cf51b1125e2623364de272d1b640bd6
        new : 9ad670319943d97c8ffa11e2428f4fa9d91c63e826e2f5f8509ffa9d460c45f8
• services/backend
        old : 1aa3f39996e526e3f530943f2d0081cde30efabc643af64ba95d157b0072c463
        new : 3fcf8f991bfe7d69db962a29d56010877072ba42dfd6fb0b3b64f3e1fc30bed3
        🚧 changed dependency(s) :
                • database
                • packages/cli-tools
                • packages/linter
• services/frontend
        old : 7251bacb2abaec585b7faa4ea56c9c74a8b7ed20422255a72442bfa7ce7dbb71
        new : 5c2b81df00712306f0eaff7021808dd5efdbbcfb93e77d730d9812f4fd6194c8
        🚧 changed dependency(s) :
                • packages/linter
```

</details>

<details><summary><h4>Hash comparison - missing hashes</h4></summary>

```bash
$ pnpm monorepo-hash --compare
ℹ️ Comparing hashes for all workspaces...

ℹ️ Using pnpm workspaces from C:\Users\EDM115\Desktop\test\small-monorepo

✅ Computed all hashes (5)

✅ Unchanged (4) :
• packages/cli-tools
• packages/linter
• services/backend
• services/frontend

❓ Missing .hash files (1) :
• database (would be 34e5c3bb9a1545fcc7eab03d439bfe79abe1b12ebb0d2c7cdacb1744e58ab22a)
```

</details>

<details><summary><h4>Hash generation - specific workspaces</h4></summary>

```bash
$ pnpm monorepo-hash --generate --target="packages/cli-tools,services/frontend"
ℹ️ Generating hashes for specified targets... (packages/cli-tools, services/frontend)

ℹ️ Using pnpm workspaces from C:\Users\EDM115\Desktop\test\small-monorepo

✅ Computed all hashes (3)

✅ packages/cli-tools (b0b7271f403749b906dec2405e6127c58c2d267695a6d84bc96f1a2918fb0d07 written to .hash)
✅ services/frontend (7251bacb2abaec585b7faa4ea56c9c74a8b7ed20422255a72442bfa7ce7dbb71 written to .hash)
```

</details>

<details><summary><h4>Hash comparison - specific workspaces - no changes</h4></summary>

```bash
$ pnpm monorepo-hash --compare --target="packages/cli-tools,services/frontend"
ℹ️ Comparing hashes for specified targets... (packages/cli-tools, services/frontend)

ℹ️ Using pnpm workspaces from C:\Users\EDM115\Desktop\test\small-monorepo

✅ Computed all hashes (3)

✅ Unchanged (2) :
• packages/cli-tools
• services/frontend
```

</details>

<details><summary><h4>Hash comparison - specific workspaces - changes detected even outside of the specified targets</h4></summary>

```bash
$ pnpm monorepo-hash --compare --target="services/backend"
ℹ️ Comparing hashes for specified targets... (services/backend)

ℹ️ Using pnpm workspaces from C:\Users\EDM115\Desktop\test\small-monorepo

✅ Computed all hashes (4)

⚠️ Changed (1) :
• services/backend
        old : 36be1199988004d364bbe3ec945eb653beef7457d336cc4e3a12a0ce6ad845c1
        new : 1aa3f39996e526e3f530943f2d0081cde30efabc643af64ba95d157b0072c463
        🚧 changed dependency(s) :
                • packages/cli-tools
```

</details>

### Usage in CI
This was the main reason I created this tool, and whether it's in GitHub Actions or locally through [act](https://github.com/nektos/act), it can help you to reduce drastically CI times.  

<details><summary><h4>Here's an example workflow that only builds the workspaces that have changed :</h4></summary>

```yaml
# The boring stuff

jobs:
  build-and-test:
    runs-on: ubuntu-24.04
    defaults:
      run:
        shell: bash
    env:
      IMAGE_TAG: "demo-${{ github.sha }}"
    strategy:
      fail-fast: false
      matrix:
        node-version: [25]

    steps:
      - name: Checkout code
        uses: actions/checkout@v6

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Use Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v6
        with:
          node-version: ${{ matrix.node-version }}
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm i --frozen-lockfile

      - name: Restore .hash cache
        id: restore-hash-cache
        uses: actions/cache@v4
        with:
          path: |
            **/.hash
          key: hash-files-${{ runner.os }}-pnpm-${{ hashFiles('**/pnpm-lock.yaml') }}
          restore-keys: |
            hash-files-${{ runner.os }}-pnpm-

      - name: Force rebuild if no cache has been found
        if: steps.restore-hash-cache.outputs.cache-hit == ''
        run: rm -fr **/.hash

      - name: Check if workspace-name is unchanged
        id: check-workspace-name
        run: |
          # These 2 lines are useful only if you use act, as a way to ensure the images are built if not present
          # WORKSPACENAME_DOCKER_EXISTS=$(docker images -q username/workspace-name:${{ env.IMAGE_TAG }} | wc -l)
          # echo "WORKSPACENAME_DOCKER_EXISTS=$WORKSPACENAME_DOCKER_EXISTS" >> ${GITHUB_OUTPUT}
          set +e
          pnpm monorepo-hash --compare --target="services/workspace-name"
          EXIT_CODE=$?
          echo "WORKSPACENAME_HASH_EXIT_CODE=$EXIT_CODE" >> ${GITHUB_OUTPUT}

      # Do this as much as needed for your workspaces

      - name: Build the workspace-name Docker image
        if: steps.check-workspace-name.outputs.WORKSPACENAME_HASH_EXIT_CODE != '0'
        # act version :
        # if: (steps.check-workspace-name.outputs.WORKSPACENAME_HASH_EXIT_CODE != '0' || steps.check-workspace-name.outputs.WORKSPACENAME_DOCKER_EXISTS == '0')
        uses: docker/build-push-action@v6
        with:
          context: .
          file: services/workspace-name/Dockerfile
          tags: username/workspace-name:${{ env.IMAGE_TAG }}
          load: true

      # Build things and test them

      # Don't do that if you delete/add files during the action !
      - name: Ensure hash files are up to date
        run: |
          pnpm monorepo-hash --generate

      - name: Save .hash cache
        uses: actions/cache@v4
        with:
          path: |
            **/.hash
          key: hash-files-${{ runner.os }}-pnpm-${{ hashFiles('**/pnpm-lock.yaml') }}
          restore-keys: |
            hash-files-${{ runner.os }}-pnpm-
```

</details>

Here we use the actions cache to store the `.hash` files, so that we can reuse them in the next runs.  
This is especially useful because when you generate hashes, the action will pick them up from the latest commit and not the latest run.  
For the very first run, you might need to create a workflow which will only checkout and save the .hash files in a cache for future runs.

## :construction: Limitations
- If you use another Version Control System than `git`, we can't ignore your files correctly for the hashes generation
- Your EOL (End of Line) should be consistent across your monorepo's files and the different environments it's being used in. Since Docker containers and GitHub Actions runners are based on Linux, it's recommended to use `LF` as EOL.  
  I recommend to set this up in your IDE and formatter config.

## :rocket: Benchmarks
These benchmarks have been realised on Standard GitHub-hosted runner (`ubuntu-24.04`) that you can get by running any Action.  
The specs as I'm writing this are an AMD EPYC 7763 64-Core (4) @ 3.24 GHz CPU, 15.62 GiB of RAM and 71.61 GiB of SSD storage. Keep in mind that since the servers are shared between multiple users, the performance may vary slightly between runs.  
They have been reproduced 10 times with a cold and warm disk cache thanks to [hyperfine](https://github.com/sharkdp/hyperfine).  
Cold cache results are more representative of a first run in CI or on a fresh boot. The script run speed doesn't really change, the only performance overhead on a cold cache is the time it takes to run Node.js/Bun (and reading files from the disk). You can expect warm cache runs to be at least 1/3 faster than cold cache ones.  
The versions denoted with `(bun)` are using the Bun binary build of `monorepo-hash`, which removes the Node.js overhead, uses Bun internal replacements and is generally faster. This build is the default one since `v2.0.0`.  
Starting with `v2.0.0`, the benchmark methodology has changed : we re-runned them for all versions in *the same runner and script* to avoid noisy neighbor effects and massive drifts in perf for no reason, and we also started to measure warm cache runs, noted in parenthesis. As a consequence, previous results that you could find in the releases aren't comparable with these new ones. More info here : [[INFO] 📣 A change in the benchmarks methodology (#20)](https://github.com/EDM115/monorepo-hash/issues/20)
> [!NOTE]  
> Here are the details of each demo monorepo used for the benchmarks :
> - **Small monorepo** : 5 workspaces of 100 files each, files composed of 1 line of text
> - **Medium monorepo** : 5 workspaces of 100 folders each, with each folder containing 100 files, files composed of 10 lines of text
> - **Large monorepo** : 5 workspaces of 100 folders each, with each folder containing 10 files and 10 folders, and each of these folders containing 100 files, files composed of 100 lines of text
> - **Wide monorepo** : 50 workspaces of 10 folders each, with each folder containing 100 files, files composed of 10 lines of text *(the most representative of a real-world monorepo with many packages)*
>
> In order to not clunk up Git, these [demo repos](./tests/demo/) are 7z ultra compressed.  
> Symbols (comparing Node with Node, Bun with Bun, the first Bun version is compared with the same version's Node) :
> - :chart_with_upwards_trend: : Faster than the previous version
> - :chart_with_downwards_trend: : Slower than the previous version
> - :balance_scale: : Negligible or no perceivable change in performance compared to the previous version

| Version                                   | Small               | Medium             | Large               | Wide               |
| :---------------------------------------- | :------------------ | :----------------- | :------------------ | :----------------- |
| `v2.0.0 (bun)` :chart_with_upwards_trend: | 231 ms (69.33 ms)   | 3.295 s (802.3 ms) | 41.083 s (17.319 s) | 3.081 s (761.9 ms) |
| `v2.0.0` :chart_with_upwards_trend:       | 282.6 ms (124.1 ms) | 3.853 s (3.532 s)  | 36.773 s (35.706 s) | 4.447 s (3.599 s)  |
| `v1.9.0 (bun)` :balance_scale:            | 224.3 ms (67.45 ms) | 3.347 s (719.9 ms) | 35.774 s (10.268 s) | 3.546 s (1.405 s)  |
| `v1.9.0` :chart_with_downwards_trend:     | 284.5 ms (129.3 ms) | 4.140 s (3.548 s)  | 42.666 s (36.751 s) | 4.063 s (3.617 s)  |
| `v1.8.0 (bun)` :chart_with_upwards_trend: | 216.5 ms (73.16 ms) | 3.285 s (752.5 ms) | 35.464 s (10.382 s) | 3.536 s (1.444 s)  |
| `v1.8.0` :chart_with_upwards_trend:       | 276.2 ms (124 ms)   | 4.057 s (3.534 s)  | 42.178 s (36.731 s) | 4.051 s (3.637 s)  |
| `v1.7.0` :balance_scale:                  | 285.2 ms (124.5 ms) | 4.117 s (3.535 s)  | 42.534 s (37.125 s) | 3.924 s (3.643 s)  |
| `v1.6.0` :chart_with_downwards_trend:     | 285.3 ms (126.6 ms) | 4.191 s (3.556 s)  | 42.940 s (37.045 s) | 4.174 s (3.636 s)  |
| `v1.5.1` :chart_with_downwards_trend:     | 290.6 ms (128 ms)   | 4.225 s (3.593 s)  | 42.419 s (36.959 s) | 4.062 s (3.644 s)  |
| `v1.5.0` :chart_with_upwards_trend:       | 265.9 ms (125.8 ms) | 4.068 s (3.573 s)  | 42.245 s (36.998 s) | 4.083 s (3.606 s)  |
| `v1.4.2` :chart_with_downwards_trend:     | 274.3 ms (130 ms)   | 4.227 s (3.574 s)  | 42.901 s (36.902 s) | 4.007 s (3.625 s)  |
| `v1.4.1` :chart_with_upwards_trend:       | 280.6 ms (123.1 ms) | 4.067 s (3.532 s)  | 42.309 s (36.820 s) | 4.038 s (3.623 s)  |
| `v1.4.0` :chart_with_upwards_trend:       | 264.1 ms (119.3 ms) | 4.150 s (3.535 s)  | 42.384 s (37.046 s) | 3.894 s (3.640 s)  |
| `v1.3.1` :chart_with_upwards_trend:       | 274 ms (136.5 ms)   | 4.366 s (4.012 s)  | 89.512 s (87.311 s) | 4.152 s (3.886 s)  |
| `v1.3.0` :chart_with_upwards_trend:       | 273.4 ms (137.9 ms) | 4.417 s (4.098 s)  | 89.956 s (88.009 s) | 4.152 s (3.898 s)  |
| `v1.2.0` :chart_with_downwards_trend:     | 280.4 ms (137.4 ms) | 4.387 s (3.965 s)  | 92.195 s (87.312 s) | 4.266 s (4.050 s)  |
| `v1.1.0` :chart_with_downwards_trend:     | 263.1 ms (122.9 ms) | 3.894 s (3.586 s)  | 56.071 s (37.309 s) | 4.299 s (4.021 s)  |
| `v1.0.0` :balance_scale:                  | 247.9 ms (119.1 ms) | 3.752 s (3.576 s)  | 56.198 s (37.479 s) | 4.370 s (4.048 s)  |

## :hammer_and_wrench: Contributing
Here's a quick guide for contributing to `monorepo-hash` :
1. Fork the repository (and star it :wink:)
2. Clone your fork
  ```bash
  git clone https://github.com/USERNAME/monorepo-hash.git
  cd monorepo-hash
  pnpm i --frozen-lockfile
  ```
3. Do your changes
4. Format, typecheck and lint your code
  ```bash
  pnpm format
  pnpm typecheck
  pnpm lint
  ```
5. Test your changes (stage them before)  
  Feel free to add tests to the `tests` directory.
  ```bash
  pnpm test
  pnpm test:binaries
  ```
6. Commit your changes
7. Open a pull request

### Release process
```bash
# bump the version in package.json
git commit && git push
pnpm typecheck
pnpm build
pnpm build:bun
# run the action that builds the binaries and download the artifacts
# create a draft release on GitHub with the bun artifacts
# compare the benchmarks ran from master and the release and pick the best ones to include as a zip artifact & in the README
git commit && git push
# un-draft and publish the release on GitHub as latest
pnpm release
```

## :eyes: Who uses `monorepo-hash` ?
- [Nexelec](https://nexelec.eu), at least during my internship there
- [Me](https://github.com/EDM115) :smile:
- You ?

If you use `monorepo-hash` in your project(s), whether you're an individual or a company, please let me know by opening an issue or a pull request, and I'll add you to this list !

## :money_with_wings: Donate
I'm a young developer from France, and as I write this I'm actively seeking for a job.  
If you want to support me, here's how you can do it :
- Star this repository
- Follow me on [GitHub](https://github.com/EDM115)
- Donate :
  - [PayPal](https://paypal.me/8EDM115)
  - [GitHub Sponsors](https://github.com/sponsors/EDM115)
  - [BuyMeACoffee](https://www.buymeacoffee.com/EDM115)
  - [Donate on Telegram](https://t.me/EDM115bots/698)

## :scroll: License
`monorepo-hash` is licensed under the [MIT License](https://github.com/EDM115/monorepo-hash/blob/master/LICENSE)
