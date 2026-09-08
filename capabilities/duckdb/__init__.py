"""Optional, policy-bounded ALG DuckDB query plane."""

from .contract import canonical_contract_bytes, contract_hash, load_contract
from .fastapi_adapter import DuckDBQueryAdapter

__all__ = ["DuckDBQueryAdapter", "canonical_contract_bytes", "contract_hash", "load_contract"]
