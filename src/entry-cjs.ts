// oxlint-disable no-require-imports
const { pathToFileURL } = require("node:url")
const {
  PACKAGE_MANAGERS,
  log,
  exists,
  zeroPad,
  safeExit,
  mapLimit,
  getWorkspaceFileList,
  isPackageManager,
  detectPNPM,
  detectDeno,
  detectPkgJson,
  autoDetect,
  detectSpecified,
  writeDebugFile,
  loadDebugFile,
  writeRootDebugFile,
  loadRootDebugFile,
  generateDebug,
  computePerFileHashes,
  computeOwnHashFromPerFile,
  computeFinalHash,
  writeRootHashFile,
  loadRootHashFile,
  generateHashes,
  compareHashes,
  hash,
  runCli,
} = require("./monorepo-hash")

// Auto-run only when executed as the main entry point (not when required)
if (pathToFileURL(process.argv[1] ?? "").href === pathToFileURL(__filename).href) {
  (async () => {
    await runCli()
  })()
    .catch((error) => {
      console.error(error)
    })
}

module.exports = {
  PACKAGE_MANAGERS,
  log,
  exists,
  zeroPad,
  safeExit,
  mapLimit,
  getWorkspaceFileList,
  isPackageManager,
  detectPNPM,
  detectDeno,
  detectPkgJson,
  autoDetect,
  detectSpecified,
  writeDebugFile,
  loadDebugFile,
  writeRootDebugFile,
  loadRootDebugFile,
  generateDebug,
  computePerFileHashes,
  computeOwnHashFromPerFile,
  computeFinalHash,
  writeRootHashFile,
  loadRootHashFile,
  generateHashes,
  compareHashes,
  hash,
  runCli,
  "default": runCli,
}
