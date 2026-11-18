# Read-only datalake Code Mode

Run the synthetic acceptance probe from the repository root with Bun, the root and V2 preview dependencies installed, and a native OpenCode **2.3.2** binary. On Linux:

```bash
bun packages/v2-preview/acceptance/code-mode.ts --host /absolute/path/to/opencode
```

The same command accepts a path to `opencode.exe` on Windows. It uses a temporary project with isolated config and data, a scripted OpenAI-compatible loopback provider, and a loopback MCP workbench. Set `ALG_CODE_MODE_TMP` to an existing writable directory if needed. No preview plugin, Git repository, real model, datalake credential, or remote datalake is used.

The Windows and WSL Linux runs both completed with `NATIVE_CODE_MODE_PASSED`. Native `execute` discovered the sources, fetched one batch of eight inspection and eight dispatch rows, and returned 114 bytes. The aggregate was 8 inspected, 7 defects, and 8 dispatch records. Its witness, the sum of the inspection timestamps, was 808. The MCP receipts linked both evidence references to the admitted batch. The durable transcript and the next provider request contained the bounded result, with neither intermediate row values nor a separate raw tool reply. A second session attempted the advertised unbounded-scan and table-write functions. Both failed inside `execute`, with zero calls to either MCP operation.

## Example role policy

This uses the fixture's names. Keep the blanket deny first and allow only the reviewed read tool. Where discovery and querying are separate, add an exact pair of allow rules for each approved tool.

```jsonc
{
  "experimental": { "full_codemode": true },
  "mcp": {
    "servers": {
      "lake": {
        "type": "remote",
        "url": "http://127.0.0.1:PORT/mcp",
        "oauth": false,
        "protocol": "legacy",
        "codemode": true
      }
    }
  },
  "agents": {
    "lake-analyst": {
      "mode": "primary",
      "permissions": [
        { "action": "*", "resource": "*", "effect": "deny" },
        { "action": "execute", "resource": "*", "effect": "allow" },
        { "action": "tool.use", "resource": "execute", "effect": "allow" },
        { "action": "mcp.use", "resource": "lake", "effect": "allow" },
        { "action": "lake_research_workbench", "resource": "*", "effect": "allow" },
        { "action": "tool.use", "resource": "lake_research_workbench", "effect": "allow" }
      ]
    }
  }
}
```

For a real service, obtain the operator-approved MCP tool IDs and input schemas from its `tools/list` catalog. Match those IDs to the exact permission names and JavaScript paths OpenCode exposes for the configured server. The fixture maps `research_workbench` to permission `lake_research_workbench` and path `tools.lake.research_workbench`. Preserve the host catalog's exact spelling and bracket notation. Keep generic SQL execution, unbounded scans, exports, and writes out of the allowlist. Use a read-only principal and enforce dataset, predicate, row, byte, cost, timeout, and network limits at the service or gateway, including for tools that multiplex operations.

Inside `execute`, discover the source, make the bounded read, and reduce the rows to an explicit summary with coverage counts and source references. Return the summary and omit row logging. The probe qualifies this scripted program and role. Code Mode can return data a program explicitly emits, so enforce an aggregate-only service contract when row disclosure must be impossible. If native `execute` is unavailable, a governed MCP tool that computes the same bounded aggregate at the service is an alternative with its own qualification.
