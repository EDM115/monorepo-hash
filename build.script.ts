import packageJson from "./package.json" with { type: "json" }

import {
  chmod,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { argv } from "node:process"
import { x } from "tinyexec"

import {
  detectPlatformId,
  exists,
} from "./src/node/platform"

const RUNTIMES = [ "bun", "rust", "go" ] as const
const PLATFORMS = [ "darwin-arm64", "darwin-x64", "linux-arm64", "linux-arm64-musl", "linux-x64", "linux-x64-musl", "windows-arm64", "windows-x64" ] as const
const packageVersion = process.env.npm_package_version || packageJson.version
const normalizedPackageVersion = normalizeVersion(packageVersion)

type Runtime = (typeof RUNTIMES)[number]

type Platform = (typeof PLATFORMS)[number]

type GoTarget = {
  goos: "darwin" | "linux" | "windows";
  goarch: "amd64" | "arm64";
}

function isValidRuntime(runtime: string): runtime is Runtime {
  return (RUNTIMES as readonly string[]).includes(runtime)
}

function isValidPlatform(platform: string): platform is Platform {
  return (PLATFORMS as readonly string[]).includes(platform)
}

async function chmodBinaries() {
  const filesToChmod: string[] = []

  const bunBuildPath = "./bun-build"
  const bunPathExists = await exists(bunBuildPath)

  if (bunPathExists) {
    const bunBuildFiles = await readdir(bunBuildPath, { withFileTypes: true })

    for (const file of bunBuildFiles) {
      if (file.isFile() && !file.name.includes(".")) {
        filesToChmod.push(join(bunBuildPath, file.name))
      }
    }
  }

  const goBuildPath = "./go-build"
  const goPathExists = await exists(goBuildPath)

  if (goPathExists) {
    const goBuildFiles = await readdir(goBuildPath, { withFileTypes: true })

    for (const file of goBuildFiles) {
      if (file.isFile() && !file.name.includes(".")) {
        filesToChmod.push(join(goBuildPath, file.name))
      }
    }
  }

  await Promise.all(filesToChmod.map(async (file) => await chmod(file, 0o755)))
}

function getGoTarget(platform: Platform): GoTarget {
  switch (platform) {
    case "darwin-arm64":
      return {
        goos: "darwin", goarch: "arm64",
      }
    case "darwin-x64":
      return {
        goos: "darwin", goarch: "amd64",
      }
    case "linux-arm64":
    case "linux-arm64-musl":
      return {
        goos: "linux", goarch: "arm64",
      }
    case "linux-x64":
    case "linux-x64-musl":
      return {
        goos: "linux", goarch: "amd64",
      }
    case "windows-arm64":
      return {
        goos: "windows", goarch: "arm64",
      }
    case "windows-x64":
      return {
        goos: "windows", goarch: "amd64",
      }
    default: {
      console.error("❌ Unsupported Go platform, this should never happen")
      process.exit(1)
    }
  }
}

function normalizeVersion(version: string): string {
  const match = (/^v?(\d+)\.(\d+)\.(\d+)/).exec(version.trim())

  if (!match) {
    return version
  }

  const [ , major, minor, patch ] = match

  return `${major}.${minor}.${patch}`
}

function toWindowsVersionParts(version: string): [number, number, number, number] {
  const core = normalizeVersion(version)
  const rawParts = core.split(".")
    .map((part) => Number.parseInt(part, 10))
  const [ major = 0, minor = 0, patch = 0 ] = rawParts

  return [ major, minor, patch, 0 ]
}

function toWindowsVersionString(version: string): string {
  return toWindowsVersionParts(version)
    .join(".")
}

async function ensureGoversioninfoTool(): Promise<void> {
  const args = [ "mod", "edit", "-json" ]
  const {
    stdout, stderr, exitCode,
  } = await x("go", args, {
    nodeOptions: {
      cwd: "./src/go",
      stdio: "pipe",
    },
  })

  if (stderr) {
    console.error(stderr)
  }

  if (exitCode !== 0) {
    console.error("❌ Failed to inspect ./src/go/go.mod")
    process.exit(exitCode)
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const modJson = JSON.parse(stdout) as {
    Tool?: Array<{
      Path?: string;
    }>;
  }

  const hasGoversioninfoTool = Array.isArray(modJson.Tool)
    && modJson.Tool.some((tool) => tool.Path === "github.com/josephspurrier/goversioninfo/cmd/goversioninfo")

  if (hasGoversioninfoTool) {
    return
  }

  console.log("ℹ️  Adding goversioninfo as a Go tool dependency in ./src/go/go.mod\n")

  const addToolArgs = [ "get", "-tool", "github.com/josephspurrier/goversioninfo/cmd/goversioninfo@latest" ]
  const result = await x("go", addToolArgs, {
    nodeOptions: {
      cwd: "./src/go",
      stdio: "inherit",
    },
  })

  if (result.exitCode !== 0) {
    console.error(`❌ Failed to add goversioninfo tool dependency (exit code ${result.exitCode})`)
    process.exit(result.exitCode)
  }

  const tidyResult = await x("go", [ "mod", "tidy" ], {
    nodeOptions: {
      cwd: "./src/go",
      stdio: "inherit",
    },
  })

  if (tidyResult.exitCode !== 0) {
    console.error(`❌ Failed to tidy Go module after adding tool dependency (exit code ${tidyResult.exitCode})`)
    process.exit(tidyResult.exitCode)
  }
}

// https://learn.microsoft.com/en-us/windows/win32/menurc/versioninfo-resource
async function writeWindowsVersionInfo(): Promise<void> {
  const [ major, minor, patch, build ] = toWindowsVersionParts(packageVersion)
  const versionString = toWindowsVersionString(packageVersion)

  const versionInfo = {
    FixedFileInfo: {
      FileVersion: {
        Major: major,
        Minor: minor,
        Patch: patch,
        Build: build,
      },
      ProductVersion: {
        Major: major,
        Minor: minor,
        Patch: patch,
        Build: build,
      },
      FileFlagsMask: "3f",
      FileFlags: "00",
      FileOS: "040004",
      FileType: "01",
      FileSubType: "00",
    },
    StringFileInfo: {
      Comments: packageJson.description,
      CompanyName: "EDM115",
      FileDescription: packageJson.description,
      FileVersion: versionString,
      InternalName: "monorepo-hash",
      LegalCopyright: "https://github.com/EDM115/monorepo-hash/blob/master/LICENSE",
      OriginalFilename: "monorepo-hash.exe",
      ProductName: packageJson.name,
      ProductVersion: versionString,
    },
    IconPath: "../../logo.ico",
  }

  await writeFile("./src/go/versioninfo.json", JSON.stringify(versionInfo, null, 2))
}

async function generateWindowsSyso(goarch: GoTarget["goarch"]): Promise<void> {
  await ensureGoversioninfoTool()
  await writeWindowsVersionInfo()

  const args = [
    "tool",
    "goversioninfo",
    goarch === "arm64"
      ? "-arm"
      : "",
    "-64",
    "-o",
    "resource.syso",
    "versioninfo.json",
  ].filter((part) => part !== "")

  console.log(`🏁 go ${args.join(" ")}\n`)

  const {
    stderr, exitCode,
  } = await x("go", args, {
    nodeOptions: {
      cwd: "./src/go",
      stdio: "inherit",
    },
  })

  if (stderr) {
    console.error(stderr)
  }

  if (exitCode !== 0) {
    console.error(`❌ Windows resource generation failed with exit code ${exitCode}`)
    process.exit(exitCode)
  }
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
 * Ability to use `current` as platform to build for the current platform.  
 * Ability to just run `jiti ./build.script.ts --chmod` to chmod +x all generated binaries (for example after a `--platform=all` build on a non-Windows platform).
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
      } else if (arg === "--chmod") {
        // oxlint-disable-next-line no-await-in-loop
        await chmodBinaries()
        console.log("✅ Successfully chmod +x binaries\n")

        return
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

  if (!options && argPlatform === "current") {
    const detectedPlatform = await detectPlatformId()

    if (!detectedPlatform) {
      console.error("❌ Failed to detect current platform")
      process.exit(1)
    }

    if (!isValidPlatform(detectedPlatform)) {
      console.error("❌ Unsupported platform, this should never happen")
      process.exit(1)
    }

    argPlatform = detectedPlatform
  }

  if (!isValidPlatform(argPlatform)) {
    console.error(`❌ Invalid platform : ${argPlatform}, valid platforms are ${PLATFORMS.join(", ")}`)
    process.exit(1)
  }

  const runtime: Runtime = argRuntime
  const platform: Platform = argPlatform

  switch (runtime) {
    case "bun": {
      await mkdir("./bun-build", { recursive: true })

      const bin = "bun"
      const isWindows = platform.startsWith("windows")
      const baseCommand = "build --compile --minify --sourcemap --bytecode --format=esm"
      const windowsSpecific = `--windows-icon=logo.ico --windows-title=monorepo-hash --windows-description=monorepo-hash --windows-publisher=EDM115 --windows-version=${normalizedPackageVersion} --windows-copyright=https://github.com/EDM115/monorepo-hash/blob/master/LICENSE`
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
    } case "go": {
      await mkdir("./go-build", { recursive: true })

      const target = getGoTarget(platform)
      const isWindows = target.goos === "windows"
      const outfile = `../../go-build/monorepo-hash-${platform}${isWindows
        ? ".exe"
        : ""}`

      if (isWindows) {
        await generateWindowsSyso(target.goarch)
      }

      const buildArgs = [
        "build",
        "-trimpath",
        "-ldflags=-s -w",
        "-o",
        outfile,
        ".",
      ]

      console.log(`🏁 go ${buildArgs.join(" ")}\n`)

      const {
        stdout, stderr, exitCode,
      } = await x("go", buildArgs, {
        nodeOptions: {
          cwd: "./src/go",
          stdio: "inherit",
          env: {
            ...process.env,
            GOEXPERIMENT: "jsonv2",
            GOOS: target.goos,
            GOARCH: target.goarch,
            CGO_ENABLED: "0",
          },
        },
      })

      if (stdout) {
        console.log(stdout)
      }

      if (stderr) {
        console.error(stderr)
      }

      if (isWindows) {
        await rm("./src/go/resource.syso", { force: true })
        await rm("./src/go/versioninfo.json", { force: true })
      }

      if (exitCode !== 0) {
        console.error(`❌ Build failed with exit code ${exitCode}`)
        process.exit(exitCode)
      }

      break
    } case "rust": {
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
