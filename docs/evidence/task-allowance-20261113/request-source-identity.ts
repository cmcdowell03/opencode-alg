import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
const root = resolve(process.argv[2]!)
const { computeAlgSourceIdentity } = await import(pathToFileURL(join(root, "src/source-identity.ts")).href)
const identity = computeAlgSourceIdentity(root)
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex")
console.log(JSON.stringify({ root, digest: identity.digest, files: identity.manifest.map((entry: {path:string}) => {
  const data = readFileSync(join(root, entry.path))
  return { path: entry.path, bytes: data.length, sha256: hash(data), lf_sha256: hash(Buffer.from(data.toString("utf8").replace(/\r\n/g, "\n"))) }
}) }, null, 2))
