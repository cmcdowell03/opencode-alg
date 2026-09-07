"""Preparation contracts and synthetic rehearsal; remote activation is unavailable."""
from .contract import ConnectorError, DeploymentRequired, PreparedSelection, activate_remote, contract_hash, load_json, prepare
from .adapter import materialize_synthetic

__all__ = ["ConnectorError", "DeploymentRequired", "PreparedSelection", "activate_remote",
           "contract_hash", "load_json", "prepare", "materialize_synthetic"]
