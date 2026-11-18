import { createHash } from "node:crypto"
import { mkdir, open, readFile, rmdir, unlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const packageDirectory = dirname(fileURLToPath(import.meta.url))

/** Build outside the source tree. A destination with a package manifest is ready to load. */
export async function buildPreview(destination: string) {
  const metadata = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"))
  const sdk = JSON.parse(await readFile(join(packageDirectory, "node_modules/@opencode/plugin/package.json"), "utf8"))
  if (sdk.version !== metadata.devDependencies["@opencode/plugin"] || sdk.version !== metadata.engines.opencode) {
    throw new Error("The preview requires matching, pinned OpenCode and plugin SDK versions")
  }
  const build = await Bun.build({
    entrypoints: [join(packageDirectory, "src/index.ts")],
    target: "bun",
    format: "esm",
    splitting: false,
    packages: "bundle",
    minify: false,
  })
  if (!build.success || build.outputs.length !== 1) throw new AggregateError(build.logs, "V2 preview bundle failed")
  const bundle = new Uint8Array(await build.outputs[0]!.arrayBuffer())
  const digest = createHash("sha256").update(bundle).digest("hex")
  const runtime = {
    name: metadata.name, version: metadata.version, private: true, type: "module",
    main: "./dist/index.js", exports: { ".": "./dist/index.js" }, engines: metadata.engines,
  }
  const out = resolve(destination)
  const dist = join(out, "dist")
  await mkdir(dirname(out), { recursive: true })
  await mkdir(out) // refuse existing destinations, including previous or concurrent builds
  const files: string[] = []
  try {
    await mkdir(dist)
    for (const [path, bytes] of [
      [join(dist, "index.js"), bundle],
      [join(out, "package.json"), JSON.stringify(runtime, null, 2) + "\n"],
    ] as const) {
      const file = await open(path, "wx")
      files.push(path)
      try {
        await file.writeFile(bytes)
      } finally {
        await file.close()
      }
    }
  } catch (error) {
    for (const file of files.reverse()) await unlink(file).catch(() => undefined)
    await rmdir(dist).catch(() => undefined)
    await rmdir(out).catch(() => undefined)
    throw error
  }
  return { name: runtime.name, version: runtime.version, host_version: sdk.version, bundle_sha256: digest, bundle_bytes: bundle.length }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length !== 1 || !args[0]) throw new Error("Usage: bun packages/v2-preview/build.ts <new-directory>")
  console.log(JSON.stringify(await buildPreview(args[0])))
}
