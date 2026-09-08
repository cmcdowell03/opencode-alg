/** Shipped optional capability inputs. Runtime identity and package checks share this inventory. */
export const DUCKDB_ASSET_FILES = [
  "__init__.py", "contract.example.json", "contract.py", "contract.schema.json", "fastapi_adapter.py",
  "opencode.disabled.json", "policy.py", "pyproject.toml", "query_plane.py", "uv.lock", "worker.py", "wrapper.py",
] as const

export const DATASCIENCE_ASSET_FILES = ["__init__.py", "catalog.py", "operations.py", "pyproject.toml", "runner.py", "uv.lock"] as const
export const CONNECTOR_ASSET_FILES = ["__init__.py", "adapter.py", "contract.py"] as const
