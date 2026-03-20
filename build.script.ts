import packageJson from "./package.json" with { type: "json" }

import { argv } from "node:process"
import { x } from "tinyexec"

const RUNTIMES = [ "bun", "rust", "go" ] as const
const PLATFORMS = [ "darwin-arm64", "darwin-x64", "linux-arm64", "linux-arm64-musl", "linux-x64", "linux-x64-musl", "windows-arm64", "windows-x64" ] as const
const packageVersion = process.env.npm_package_version || packageJson.version

type Runtime = (typeof RUNTIMES)[number]

type Platform = (typeof PLATFORMS)[number]

function isValidRuntime(runtime: string): runtime is Runtime {
  return (RUNTIMES as readonly string[]).includes(runtime)
}

function isValidPlatform(platform: string): platform is Platform {
  return (PLATFORMS as readonly string[]).includes(platform)
}

/**
 * Build script for monorepo-hash.  
 * Helps to build the binary in whatever runtime for whatever platform.  
 * Usage :
 * ```bash
 * jiti ./build.script.ts --runtime=bun --platform=linux-x64-musl
 * ```
 * Available runtimes : `bun`, `rust`, `go`.  
 * Available platforms : `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-arm64-musl`, `linux-x64`, `linux-x64-musl`, `windows-arm64`, `windows-x64`.  
 * Shorthands : `-r bun`, `-p linux-x64-musl`.  
 * Exits with code 1 when not both params are provided or when an invalid param is provided.  
 * Ability to use `all` as platform to build for all platforms.
 */
async function main(options?: {
  runtime: string; platform: string;
}): Promise<void> {
  const args = argv.slice(2)
  let argRuntime: string | undefined
  let argPlatform: string | undefined

  if (!options) {
    for (const arg of args) {
      if (arg.startsWith("--runtime=")) {
        argRuntime = arg.split("=")[1]
      } else if (arg.startsWith("--platform=")) {
        argPlatform = arg.split("=")[1]
      } else if (arg === "-r") {
        argRuntime = args[args.indexOf(arg) + 1]
      } else if (arg === "-p") {
        argPlatform = args[args.indexOf(arg) + 1]
      }
    }
  } else {
    argRuntime = options.runtime
    argPlatform = options.platform
  }

  if (!argRuntime || !argPlatform) {
    console.error("❌ Both --runtime and --platform must be provided")
    process.exit(1)
  }

  if (!isValidRuntime(argRuntime)) {
    console.error(`❌ Invalid runtime : ${argRuntime}, valid runtimes are ${RUNTIMES.join(", ")}`)
    process.exit(1)
  }

  if (!options && argPlatform === "all") {
    for (const platform of PLATFORMS) {
      // oxlint-disable-next-line no-await-in-loop
      await main({
        runtime: argRuntime, platform,
      })
    }

    return
  }

  if (!isValidPlatform(argPlatform)) {
    console.error(`❌ Invalid platform : ${argPlatform}, valid platforms are ${PLATFORMS.join(", ")}`)
    process.exit(1)
  }

  const runtime: Runtime = argRuntime
  const platform: Platform = argPlatform

  switch (runtime) {
    case "bun": {
      const bin = "bun"
      const isWindows = platform.startsWith("windows")
      const baseCommand = "build --compile --minify --sourcemap --bytecode --format=esm"
      const windowsSpecific = `--windows-icon=logo.ico --windows-title=monorepo-hash --windows-description=monorepo-hash --windows-publisher=EDM115 --windows-version=${packageVersion} --windows-copyright=https://github.com/EDM115/monorepo-hash/blob/master/LICENSE`
      const buildCommand = `--target=bun-${platform} ./src/bun/monorepo-hash.ts --outfile ./bun-build/monorepo-hash-${platform}${isWindows
        ? ".exe"
        : ""}`

      const fullCommand = `${baseCommand} ${isWindows
        ? windowsSpecific
        : ""} ${buildCommand}`
      const arrayCommand = fullCommand.split(" ")
        .filter((part) => part !== "")

      console.log(`🏁 ${bin} ${arrayCommand.join(" ")}\n`)
      const {
        stdout, stderr, exitCode,
      } = await x(bin, arrayCommand, { nodeOptions: { stdio: "inherit" } })

      console.log(stdout)

      if (stderr) {
        console.error(stderr)
      }

      if (exitCode !== 0) {
        console.error(`❌ Build failed with exit code ${exitCode}`)
        process.exit(exitCode)
      }

      break
    } case "rust": {
      console.log("👀 Not yet...")

      break
    } case "go": {
      console.log("👀 Not yet...")

      break
    } default: {
      console.error("❌ Unsupported runtime, this should never happen")
      process.exit(1)
    }
  }

  console.log(`✅ Successfully built for runtime ${runtime} and platform ${platform}\n`)
}

await main()
