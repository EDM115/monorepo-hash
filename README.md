<div align="center">

# monorepo-hash
**A CLI tool to generate hashes for the workspaces of your monorepo**

<img src="https://raw.githubusercontent.com/EDM115/monorepo-hash/refs/heads/master/logo.webp" alt="monorepo-hash logo" width="200" height="200">

![NPM Version](https://img.shields.io/npm/v/monorepo-hash) ![NPM Downloads](https://img.shields.io/npm/dt/monorepo-hash)  
![Dependent repos (via libraries.io)](https://img.shields.io/librariesio/dependent-repos/npm/monorepo-hash) ![Dependents (via libraries.io)](https://img.shields.io/librariesio/dependents/npm/monorepo-hash)  
![Libraries.io dependency status for latest release](https://img.shields.io/librariesio/release/npm/monorepo-hash) ![Libraries.io SourceRank](https://img.shields.io/librariesio/sourcerank/npm/monorepo-hash)

## :memo: Features
:runner: **Fast** : Runs in huge monorepos [in no time](#rocket-benchmarks), processes workspaces in parallel  
:dart: **Accurate** : Generates hashes based on every tracked file  
:left_right_arrow: **Complete** : Supports transitive workspace dependencies  
:ok_hand: **No config** : Drop-in and instantly usable  
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
# or npm, yarn, deno, bun
# monorepo-hash was originally made with only PNPM in mind, open an issue if you encounter any problem
```
> [!IMPORTANT]  
> Since `v1.8.0`, `monorepo-hash` exports direct binaries (`monorepo-hash-bun`) that cut the Node.js overhead. To enable this, the postinstall script needs to be run, which is disabled by default in PNPM for security reasons.  
> You can totally refuse to use it (whether it is for security reasons or size constraints). If you added `monorepo-hash` without allowing the postinstall script to run, you can do it later at anytime with `pnpm approve-scripts`.  
> You can safely ignore the PNPM warnings about the nonexistent binary since it is retrieved as part of the postinstall script.

> [!TIP]  
> Make sure that your workspace configuration is set up correctly (`pnpm-workspace.yaml`, `package.json` workspaces or `deno.json(c)` workspace) as `monorepo-hash` will use it to find your workspaces. Globs are supported.  
> Make sure that your lockfiles are present since they are used to detect the used package manager. To skip this resolution step, use the `--packagemanager` argument to force one.  
> `monorepo-hash` will also use the `workspace:` field in your `package.json` files to detect transitive dependencies.  
> Finally, it will generate `.hash` files for each workspace that you would need to keep in your VCS in order for it to be efficient (ex : to be reused in your CI). If you don't like having extra files or you have hundred of packages, use the `--unified` mode to obtain a single root `.hash` file instead.

### Get help
```bash
pnpm monorepo-hash --help
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
This will suppress all output except for errors. This can be useful for example in CI where only the exit code matters.
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
async function checkHashes() {
  const compareResult = await monorepoHash(["--compare", "--target=packages/example"])
  // do something with it...
}
```

### Run in debug mode
The debug mode will :
- in generate mode, output `.debug-hash` files which will contain the hashes of each individual file in the workspace as a JSON object (or a single root file when using `--unified`)
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

✅ Computed all hashes (5)

✅ database (34e5c3bb9a1545fcc7eab03d439bfe79abe1b12ebb0d2c7cdacb1744e58ab22a) written to .hash
✅ packages\cli-tools (b0b7271f403749b906dec2405e6127c58c2d267695a6d84bc96f1a2918fb0d07) written to .hash
✅ packages\linter (aa37077b2c0034ce44a074d8a46778153cf51b1125e2623364de272d1b640bd6) written to .hash
✅ services\backend (1aa3f39996e526e3f530943f2d0081cde30efabc643af64ba95d157b0072c463) written to .hash
✅ services\frontend (7251bacb2abaec585b7faa4ea56c9c74a8b7ed20422255a72442bfa7ce7dbb71) written to .hash
```

</details>

<details><summary><h4>Hash comparison - no changes</h4></summary>

```bash
$ pnpm monorepo-hash --compare
ℹ️ Comparing hashes for all workspaces...

✅ Computed all hashes (5)

✅ Unchanged (5) :
• database
• packages\cli-tools
• packages\linter
• services\backend
• services\frontend
```

</details>

<details><summary><h4>Hash comparison - changes detected</h4></summary>

```bash
$ pnpm monorepo-hash --compare
ℹ️ Comparing hashes for all workspaces...

✅ Computed all hashes (5)

⚠️ Changed (5) :
• database
        old : 34e5c3bb9a1545fcc7eab03d439bfe79abe1b12ebb0d2c7cdacb1744e58ab22a
        new : d5c33df5c178385d5f3cb90da5b72a8a699e5c69d446dbc6bed69c0ef2bd0c03
        🚧 changed dependency(s) :
                • packages\linter
• packages\cli-tools
        old : b0b7271f403749b906dec2405e6127c58c2d267695a6d84bc96f1a2918fb0d07
        new : dc8e3feeb66909003114a0cbc12b4693a21291433bdd000141b0a795f9ca8b25
        🚧 changed dependency(s) :
                • packages\linter
• packages\linter
        old : aa37077b2c0034ce44a074d8a46778153cf51b1125e2623364de272d1b640bd6
        new : dd73da7037b50eb1b0defd8858d5235ae0bf9d07d5cf31fb57789ac9a5b9f455
• services\backend
        old : 1aa3f39996e526e3f530943f2d0081cde30efabc643af64ba95d157b0072c463
        new : ddba925c23bf35e5b47cd65ffec2846d7631e24d621baa527bc24f5ce3c4f4a5
        🚧 changed dependency(s) :
                • database
                • packages\cli-tools
                • packages\linter
• services\frontend
        old : 7251bacb2abaec585b7faa4ea56c9c74a8b7ed20422255a72442bfa7ce7dbb71
        new : a7e40bc42980b6c56982259c6641e0f370cb171496046a810272f23c041500ab
        🚧 changed dependency(s) :
                • packages\linter
```

</details>

<details><summary><h4>Hash comparison - missing hashes</h4></summary>

```bash
$ pnpm monorepo-hash --compare
ℹ️ Comparing hashes for all workspaces...

✅ Computed all hashes (5)

✅ Unchanged (4) :
• packages\cli-tools
• packages\linter
• services\backend
• services\frontend

❓ Missing .hash files (1) :
• database (would be d5c33df5c178385d5f3cb90da5b72a8a699e5c69d446dbc6bed69c0ef2bd0c03)
```

</details>

<details><summary><h4>Hash generation - specific workspaces</h4></summary>

```bash
$ pnpm monorepo-hash --generate --target="packages/cli-tools,services/frontend"
ℹ️ Generating hashes for specified targets... (packages\cli-tools, services\frontend)

✅ Computed all hashes (3)

✅ packages\cli-tools (dc8e3feeb66909003114a0cbc12b4693a21291433bdd000141b0a795f9ca8b25) written to .hash
✅ services\frontend (a7e40bc42980b6c56982259c6641e0f370cb171496046a810272f23c041500ab) written to .hash
```

</details>

<details><summary><h4>Hash comparison - specific workspaces - no changes</h4></summary>

```bash
$ pnpm monorepo-hash --compare --target="packages/cli-tools,services/frontend"
ℹ️ Comparing hashes for specified targets... (packages\cli-tools, services\frontend)

✅ Computed all hashes (3)

✅ Unchanged (2) :
• packages\cli-tools
• services\frontend
```

</details>

<details><summary><h4>Hash comparison - specific workspaces - changes detected</h4></summary>

```bash
$ pnpm monorepo-hash --compare --target="services/backend"
ℹ️ Comparing hashes for specified targets... (services\backend)

✅ Computed all hashes (4)

⚠️ Changed (1) :
• services\backend
        old : ddba925c23bf35e5b47cd65ffec2846d7631e24d621baa527bc24f5ce3c4f4a5
        new : 2dd588551cf7604896e4eac69bfa2aa1c90c24ff1dff6b7783a7f84b9e3aa4c4
        🚧 changed dependency(s) :
                • packages\cli-tools
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
        node-version: [24]

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
- Bases the transitive dependency detection on the `workspace:` field in the `package.json` files
- If you use another Version Control System than `git`, we can't ignore your files correctly for the hashes generation
- Your EOL (End of Line) should be consistent across your monorepo's files and the different environments it's being used in. Since Docker containers and GitHub Actions runners are based on Linux, it's recommended to use `LF` as EOL.  
  I recommend to set this up in your IDE and formatter config.

## :rocket: Benchmarks
These benchmarks have been realised on Standard GitHub-hosted runner that you can get by running any Action.  
The specs as I'm writing this are an AMD EPYC 7763 64-Core (4) @ 3.24 GHz CPU, 15.62 GiB of RAM and 71.61 GiB of SSD storage.  
They have been reproduced 10 times with a cold disk cache thanks to [hyperfine](https://github.com/sharkdp/hyperfine).  
Warm cache usage is usually 2/3 times faster than cold cache, so these results are more representative of a first run in CI or on a fresh boot. The script run speed doesn't really change, the only performance overhead on a cold cache is the time it takes to run Node.js (and reading files from the disk).
> [!NOTE]  
> Here are the details of each demo monorepo used for the benchmarks :
> - **Small monorepo** : 5 workspaces of 100 files each, files composed of 1 line of text
> - **Medium monorepo** : 5 workspaces of 100 folders each, with each folder containing 100 files, files composed of 10 lines of text
> - **Large monorepo** : 5 workspaces of 100 folders each, with each folder containing 10 files and 10 folders, and each of these folders containing 100 files, files composed of 100 lines of text  
>
> In order to not clunk up Git, these [demo repos](./tests/demo/) are compressed.  
> Symbols :
> - :chart_with_upwards_trend: : Faster than the previous version
> - :chart_with_downwards_trend: : Slower than the previous version
> - :balance_scale: : No perceivable change in performance compared to the previous version

| Version                                     | Small    | Medium  | Large    |
| :------------------------------------------ | :------- | :------ | :------- |
| `v1.8.0 (bun)` :chart_with_upwards_trend:   | 219.2 ms | 3.253 s | 48.768 s |
| `v1.8.0` :chart_with_downwards_trend:       | 297.1 ms | 4.010 s | 55.842 s |
| `v1.7.0` :chart_with_upwards_trend:         | 257.5 ms | 3.655 s | 55.136 s |
| `v1.6.0` :chart_with_downwards_trend:       | 290.5 ms | 4.128 s | 56.348 s |
| `v1.5.1` :balance_scale:                    | 284.9 ms | 3.948 s | 55.728 s |
| `v1.5.0` :balance_scale:                    | 266.8 ms | 3.947 s | 55.896 s |
| `v1.4.2` :chart_with_upwards_trend:         | 277.5 ms | 3.639 s | 54.694 s |
| `v1.4.1` :chart_with_downwards_trend:       | 371.8 ms | 5.240 s | 62.899 s |
| `v1.4.0` :chart_with_upwards_trend:         | 302.4 ms | 4.417 s | 58.606 s |
| `v1.3.1` :chart_with_downwards_trend:       | 372.2 ms | 5.470 s | 96.353 s |
| `v1.3.0` :chart_with_upwards_trend:         | 303.5 ms | 4.415 s | 92.203 s |
| `v1.2.0` :chart_with_downwards_trend:       | 345.3 ms | 4.442 s | 93.391 s |
| `v1.1.0` :chart_with_upwards_trend:         | 284.1 ms | 3.884 s | 56.717 s |
| `v1.0.0` :balance_scale:                    | 318.6 ms | 4.699 s | 58.094 s |

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
5. Test your changes  
  Feel free to add tests to the `tests` directory.
  ```bash
  pnpm test
  pnpm build:bun
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
