import { runCli } from "./monorepo-hash"

(async () => {
  await runCli()
})()
  .catch((error: unknown) => {
    console.error(error)
  })
