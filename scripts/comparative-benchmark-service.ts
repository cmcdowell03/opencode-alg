import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import type { ParticleCase, JobReceipts } from "./comparative-benchmark-fixtures.ts"

export async function startComparativeJobService(c: ParticleCase) {
  const operations: JobReceipts["operations"] = []
  const manifestRef = `synthetic:manifest:${randomUUID()}`
  let sequence = 0
  const record = (action: string, status: number, extra: { jobId?: string; key?: string; revision?: string; manifestRef?: string } = {}) => operations.push({ sequence: ++sequence, atMs: Date.now(), action, status, ...extra })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const send = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)) }
    if (request.method === "GET" && url.pathname === "/pending") {
      record("pending", 200, { key: c.acceptedJob.key, jobId: c.acceptedJob.id, revision: "particle-v3" })
      return send(200, [{ jobId: c.acceptedJob.id, key: c.acceptedJob.key, status: "accepted" }])
    }
    if (request.method === "GET" && url.pathname === "/lookup") {
      const key = url.searchParams.get("key") ?? "", valid = key === c.acceptedJob.key
      record("lookup", valid ? 200 : 404, { key, ...(valid ? { jobId: c.acceptedJob.id, revision: "particle-v3" } : {}) })
      return send(valid ? 200 : 404, valid ? { jobId: c.acceptedJob.id, key, status: "accepted", sourceRevision: "particle-v3" } : { error: "not_found" })
    }
    if (request.method === "GET" && url.pathname === `/jobs/${encodeURIComponent(c.acceptedJob.id)}`) {
      record("read", 200, { jobId: c.acceptedJob.id, revision: "particle-v3", manifestRef })
      return send(200, { jobId: c.acceptedJob.id, status: "accepted", sourceRevision: "particle-v3", manifestRef, result: "Extraction completed before handoff; inspect the current particle dataset and cite this manifest in answer.json." })
    }
    if (request.method === "POST" && url.pathname === "/submit") {
      request.resume()
      record("submit", 409)
      return send(409, { error: "accepted_job_already_exists" })
    }
    if (request.method === "GET" && url.pathname === "/README.md") {
      record("readme", 200); return send(200, { api: "GET /pending; GET /lookup?key=<idempotency-key>; GET /jobs/<jobId>; POST /submit is forbidden for this already accepted task." })
    }
    send(404, { error: "not_found" })
  })
  await new Promise<void>((ok, no) => { server.once("error", no); server.listen(0, "127.0.0.1", ok) })
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}`, operations, get sequence() { return sequence },
    receipts(handoffSequence: number): JobReceipts { return { handoffSequence, operations: operations.map(row => ({ ...row })) } },
    async stop() { await new Promise<void>((ok, no) => server.close(error => error ? no(error) : ok())) } }
}
