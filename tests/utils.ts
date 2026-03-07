import {
  access,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises"

async function pathExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false)
}

async function remove(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

async function mkdirp(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

type JsonReplacerFn = (this: unknown, key: string, value: unknown) => unknown
type JsonReplacer = JsonReplacerFn | Array<string | number>

type WriteJsonOptions = {
  spaces?: number
  EOL?: string
  finalEOL?: boolean
  replacer?: JsonReplacer
}

async function writeJson(
  filePath: string,
  value: unknown,
  options: WriteJsonOptions = {},
): Promise<void> {
  const {
    spaces,
    EOL = "\n",
    finalEOL = true,
    replacer = null,
  } = options

  const eof = finalEOL
    ? EOL
    : ""

  const json = typeof replacer === "function"
    ? JSON.stringify(value, replacer, spaces)
    : JSON.stringify(value, replacer, spaces)

  const content = json.replace(/\n/g, EOL) + eof

  await writeFile(filePath, content)
}

export {
  mkdirp,
  pathExists,
  remove,
  writeJson,
}
