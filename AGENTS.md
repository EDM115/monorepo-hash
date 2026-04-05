# AI Agents guidance - `monorepo-hash`

## Structure
### CLI
The original CLI have been written in pure TS to run in Node.  
`src/node/monorepo-hash.ts` is the source of truth for any other modifications. Its existing behavior (ex logs, capitalization, punctuation, ...) should be preserved as much as possible.  
When editing the source of other implementations, make sure that they follow the same logic as the original one.  
When adding features/fixing bugs, make sure to do it everywhere.  
`src/node/install-binary.ts` is the script ran as a `postinstall` step of the NPM package. `monorepo-hash` is solely distributed through the NPM registry, and the generated binary is also grabbed on install to be ran faster. When installed, the `monorepo-hash` endpoint points to the binary, while `monorepo-hash-js` allows to run the original Node version. This script is never ran in development.  
`src/bun/monorepo-hash.ts` have been written to generate a binary using Bun. It uses Bun's internals to run faster, and was distributed as the binary from v1.8.0 to v2.1.1. Its behavior is identical to the Node version.  
`src/go/monorepo-hash.go` is the Go implementation of the CLI. It should be as close as possible to the original one, but some differences may be acceptable if they are justified by the language differences. Behavior must be identical, but not all functions should behave the same. The goal is to have something at least a little bit idiomatic to Go, while still being as close as possible to the original. It will replace the Bun binary starting v2.2.0.  
`src/rust/src/main.rs` is the Rust implementation of the CLI. It should follow the exact same user-facing behavior and shared test expectations as the Go and Bun binaries, while remaining reasonably idiomatic to Rust where that does not affect compatibility.  
**All versions should prioritize 3 aspects (in order) :**
1. Speed
2. Behavior consistency
3. Low memory usage

### Tests
We use Vitest and projects to separate tests between the implementations.  
When adding new tests (ex for a new feature), make sure to add them everywhere. When fixing bugs, make sure to add a test that validates the fix, and add it everywhere.  
When editing source for any of the 4 implementations, make sure to re-build them before running tests to not run them against stale code.  
`tests/harnesses` houses all the actual tests. This is done to avoid duplicating the exact same things between implementations. It also houses the test snapshots. When adding tests, make sure to add them here, and then import them in the right test files for each implementation.  
`tests/node` include more tests than the shared ones since users can import the package to use it programmatically, hence a need to validate the behavior of the exported functions.  
`tests/bun`, `tests/go` and `tests/rust` only run the shared tests from `harnesses`.  
The runtime wrappers should stay very thin: set up the binary in `tests/<runtime>/setup.ts`, then call the shared `defineXxxSuite(runCli)` helpers from `tests/harnesses`.

## Scripts & Deps
Everything is in the `package.json`. This project *isn't* a monorepo.  
We use `PNPM` as a package manager **and** a task runner (even for non-Node related tasks).  
Dependencies in the `package.json` are shared between the Node and Bun implementations. For Go, see `src/go/go.mod`. For Rust, see `src/rust/Cargo.toml`.  
For building the binaries, we have a custom script (`build.script.ts`) that calls `bun`, `go` or `cargo` directly and crafts the right arguments to pass.  
The Node version is built using `tsdown`. No third-party dependency is ever shipped to users on install.

## To keep in mind
- The CLI must be cross-platform. Check what we do (ex path normalization)
- It should be deterministic
- It's fine to derive from the OG implementation when it leads to one of the 3 aspects being better (ex more optimized function declaration in Go), as long as it doesn't introduce any change that might be considered breaking by existing users. Even tiny things like what's logged could be relied on by users.
- When in doubt, ask the developer
- A lot of the behavior is explained in the `README.md`
- When running tests by directly calling `pnpm vitest`, use the `--reporter=agent` flag
