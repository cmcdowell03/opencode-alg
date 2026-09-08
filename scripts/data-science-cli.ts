import { isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

export function runDataScience(args: string[]) {
  const [python, project, request] = args
  if (args.length !== 3 || !python || !project || !request || ![python, project, request].every(isAbsolute)) {
    throw new Error("usage: data-science <absolute-prepared-python> <absolute-project> <absolute-request.json>")
  }
  const runner = fileURLToPath(new URL("../capabilities/datascience/runner.py", import.meta.url))
  const result = spawnSync(python, ["-I", "-B", runner, "--project", project, "--request", request], {
    encoding: "utf8", timeout: 35_000, maxBuffer: 128 * 1024, windowsHide: true,
    env: Object.fromEntries(["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"].filter((key) => process.env[key]).map((key) => [key, process.env[key]!])),
  })
  if (result.error) throw new Error("data-science runner did not complete within its bound")
  const parsed = JSON.parse(result.stdout)
  if (typeof parsed?.ok !== "boolean") throw new Error("invalid data-science response")
  return parsed
}

if (import.meta.main || (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  try {
    const result = runDataScience(process.argv.slice(2))
    console.log(JSON.stringify(result))
    if (!result.ok) process.exitCode = 1
  } catch { console.error(JSON.stringify({ ok: false, error: "data-science invocation failed; check prepared runtime and request" })); process.exitCode = 1 }
}
