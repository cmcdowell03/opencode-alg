"""Parser/AST-backed, fail-closed SQL policy. This module never opens DuckDB."""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError, TokenError, ErrorLevel
from sqlglot.optimizer.scope import Scope, traverse_scope
from sqlglot.tokens import TokenType, Tokenizer

PARSER_VERSION = "27.14.0"
logging.getLogger("sqlglot").setLevel(logging.ERROR)


class PolicyError(ValueError):
    """The statement is outside the query-plane policy."""


@dataclass(frozen=True)
class ValidatedQuery:
    sql: str
    executing: bool
    explain: bool
    analyze: bool
    statement_class: str
    relations: tuple[str, ...]


# Every non-function expression admitted by v1 is named here. A new sqlglot node
# therefore fails closed until it receives an explicit review.
ALLOWED_NODE_NAMES = {
    "Add", "Alias", "And", "Between", "Boolean", "Bracket", "Case", "Cast", "CTE", "Column",
    "Concat", "DataType", "DataTypeParam", "Distinct", "Div", "Dot", "DPipe", "EQ", "Filter",
    "From", "Group", "GroupingSets", "GT", "GTE", "Having", "Identifier", "If", "ILike", "In",
    "Interval", "Is", "Join", "Like", "Limit", "Literal", "LT", "LTE", "Mod", "Mul", "NEQ",
    "Neg", "Not", "Null", "NullSafeEQ", "NullSafeNEQ", "Offset", "Or", "Order", "Ordered", "Paren",
    "Partition", "Pow", "Qualify", "Select", "Star", "Sub", "Subquery", "Table", "TableAlias", "Tuple",
    "When", "Where", "Window", "WindowSpec", "With", "WithinGroup",
}

# Functions are also exact-name allowlisted. In particular, anonymous/table,
# file/network, settings, query-evaluation, and secret functions never pass.
ALLOWED_FUNCTIONS = {
    "abs", "approx_count_distinct", "avg", "cast", "ceil", "ceiling", "coalesce", "count",
    "current_date", "date_diff", "date_part", "date_trunc", "day", "extract", "first", "floor",
    "greatest", "last", "least", "length", "lower", "max", "median", "min", "month", "nullif",
    "quantile", "quantile_cont", "quantile_disc", "round", "row_number", "stddev", "stddev_pop",
    "stddev_samp", "string_agg", "sum", "try_cast", "upper", "variance", "var_pop", "var_samp", "year",
}

URL_OR_ABSOLUTE_PATH = re.compile(
    r"(?:\b[a-z][a-z0-9+.-]*://|\b(?:file|s3|s3a|gs|gcs|azure|az|hf):|(?:^|[\s'\"])[A-Za-z]:[\\/]|^[/\\]{1,2})",
    re.I,
)


def _parse_inner(sql: str, label: str) -> exp.Select:
    try:
        statements = [item for item in sqlglot.parse(sql, read="duckdb", error_level=ErrorLevel.RAISE) if item is not None]
    except (ParseError, TokenError, ValueError) as error:
        raise PolicyError(f"{label} parser rejected the statement") from error
    if len(statements) != 1:
        raise PolicyError(f"{label} must contain exactly one statement")
    root = statements[0]
    if not isinstance(root, exp.Select):
        raise PolicyError("only SELECT, WITH ... SELECT, EXPLAIN SELECT, and EXPLAIN ANALYZE SELECT are allowed")
    return root


def _parse_query(sql: str, max_sql_characters: int) -> tuple[exp.Select, bool, bool]:
    if sqlglot.__version__ != PARSER_VERSION:
        raise PolicyError("SQL parser version differs from the reviewed policy version")
    if not isinstance(sql, str) or not sql.strip() or len(sql) > max_sql_characters or "\x00" in sql:
        raise PolicyError("SQL must contain exactly one bounded non-empty statement")
    try:
        statements = [item for item in sqlglot.parse(sql, read="duckdb", error_level=ErrorLevel.RAISE) if item is not None]
    except (ParseError, TokenError, ValueError) as error:
        raise PolicyError("SQL parser rejected the statement") from error
    if len(statements) != 1:
        raise PolicyError("SQL must contain exactly one statement")
    parsed = statements[0]
    if isinstance(parsed, exp.Select):
        return parsed, False, False
    if not isinstance(parsed, exp.Command) or str(parsed.this).upper() != "EXPLAIN":
        raise PolicyError("only SELECT, WITH ... SELECT, EXPLAIN SELECT, and EXPLAIN ANALYZE SELECT are allowed")
    payload = parsed.expression
    if not isinstance(payload, exp.Literal) or not payload.is_string:
        raise PolicyError("ambiguous EXPLAIN is prohibited")
    inner = str(payload.this)
    try:
        tokens = Tokenizer(dialect="duckdb").tokenize(inner)
    except (TokenError, ValueError) as error:
        raise PolicyError("EXPLAIN payload tokenizer rejected the statement") from error
    if not tokens:
        raise PolicyError("EXPLAIN requires SELECT")
    analyze = tokens[0].token_type == TokenType.ANALYZE
    if analyze:
        # Token offsets, rather than a textual prefix, identify and remove the
        # grammar token before the remaining statement is parsed into an AST.
        inner = inner[tokens[0].end + 1 :]
    return _parse_inner(inner, "EXPLAIN"), True, analyze


def _normalized_table(table: exp.Table) -> str:
    if not isinstance(table.this, exp.Identifier):
        raise PolicyError("table-producing functions, macros, and replacement scans are prohibited")
    if not isinstance(table.args.get("catalog"), exp.Identifier) or not isinstance(table.args.get("db"), exp.Identifier):
        raise PolicyError("every physical relation must use exact catalog.schema.relation qualification")
    parts = (table.catalog, table.db, table.name)
    if any(not part or "\x00" in part for part in parts):
        raise PolicyError("relation identifier is invalid")
    return ".".join(parts).lower()


def _partition_column(node: exp.Expression, alias: str, column: str) -> bool:
    return (
        isinstance(node, exp.Column)
        and node.name.lower() == column
        and node.table.lower() == alias
        and not node.args.get("db")
        and not node.args.get("catalog")
    )


def _safe_partition_value(node: Any) -> bool:
    if isinstance(node, exp.Literal):
        return True
    if isinstance(node, exp.Neg):
        return isinstance(node.this, exp.Literal) and not node.this.is_string
    if isinstance(node, (exp.Cast, exp.TryCast)):
        return _safe_partition_value(node.this) and isinstance(node.args.get("to"), exp.DataType)
    if isinstance(node, exp.Tuple):
        values = node.expressions
        return bool(values) and all(_safe_partition_value(value) for value in values)
    return False


def _safe_partition_comparison(node: exp.Expression, alias: str, column: str) -> bool:
    # v1 has no maximum partition-window contract. Only a bounded finite
    # selection can establish a restriction; open ranges/BETWEEN fail closed.
    if isinstance(node, exp.EQ):
        return _partition_column(node.this, alias, column) and _safe_partition_value(node.expression)
    if isinstance(node, exp.In):
        values = node.expressions
        return (
            _partition_column(node.this, alias, column)
            and node.args.get("query") is None
            and 1 <= len(values) <= 32
            and all(_safe_partition_value(value) for value in values)
        )
    return False


def _predicate_on_every_path(node: exp.Expression | None, alias: str, column: str) -> bool:
    if node is None or isinstance(node, exp.Not):
        return False
    if isinstance(node, exp.Paren):
        return _predicate_on_every_path(node.this, alias, column)
    if isinstance(node, exp.And):
        return _predicate_on_every_path(node.left, alias, column) or _predicate_on_every_path(node.right, alias, column)
    if isinstance(node, exp.Or):
        return _predicate_on_every_path(node.left, alias, column) and _predicate_on_every_path(node.right, alias, column)
    return _safe_partition_comparison(node, alias, column)


def _scope_filter(scope: Scope) -> exp.Expression | None:
    expression = scope.expression
    where = expression.args.get("where")
    combined = where.this if isinstance(where, exp.Where) else None
    for join in expression.args.get("joins") or []:
        on = join.args.get("on")
        if isinstance(on, exp.Expression):
            combined = on if combined is None else exp.and_(combined, on, copy=False)
    return combined


def _validate_ast(root: exp.Select, sensitive: set[str]) -> None:
    for node in root.walk():
        name = type(node).__name__
        if name in ALLOWED_NODE_NAMES:
            pass
        elif isinstance(node, exp.Func):
            name = node.sql_name().lower()
            if name not in ALLOWED_FUNCTIONS:
                raise PolicyError(f"function is not allowlisted: {name}")
        else:
            raise PolicyError(f"SQL AST node is not allowlisted: {name}")
        if isinstance(node, exp.With) and node.args.get("recursive"):
            raise PolicyError("recursive CTEs are prohibited")
        if isinstance(node, exp.Literal) and node.is_string and URL_OR_ABSOLUTE_PATH.search(str(node.this)):
            raise PolicyError("URL and absolute-path literals are prohibited")
        if isinstance(node, exp.Column) and node.name.lower() in sensitive:
            raise PolicyError("direct references to sensitive columns are prohibited; use reviewed star redaction or a fixture")
        if isinstance(node, exp.Join):
            side = str(node.args.get("side") or "").upper()
            kind = str(node.args.get("kind") or "").upper()
            method = str(node.args.get("method") or "").upper()
            if side or kind not in {"", "INNER", "CROSS"} or method:
                raise PolicyError("join form is not allowlisted")
        if isinstance(node, exp.TableAlias) and node.args.get("columns"):
            raise PolicyError("positional relation column aliases are prohibited")
        if isinstance(node, (exp.Dot, exp.Bracket)):
            raise PolicyError("structured value access is not supported")
        if isinstance(node, exp.Column) and not node.table:
            raise PolicyError("column references must be explicitly relation-qualified")
        if isinstance(node, exp.Star) and not isinstance(node.parent, exp.Count):
            raise PolicyError("star projections are prohibited; qualify every selected column as alias.column")
        if isinstance(node, exp.Star) and any(node.args.values()):
            raise PolicyError("star transformations are prohibited")


def validate_sql(sql: str, policy: dict[str, Any]) -> ValidatedQuery:
    root, explain, analyze = _parse_query(sql, policy["max_sql_characters"])
    sensitive = {column.lower() for column in policy["sensitive_columns"]}
    _validate_ast(root, sensitive)
    allowed = {item.lower() for item in policy["allowed_relations"]}
    protected = {key.lower(): tuple(column.lower() for column in value) for key, value in policy["protected_relations"].items()}
    relations: list[str] = []
    scopes = list(traverse_scope(root))
    if not scopes:
        raise PolicyError("query scope could not be resolved")
    for scope in scopes:
        query_filter = _scope_filter(scope)
        for visible_alias, source in scope.sources.items():
            source_node = source
            if isinstance(source, Scope):
                continue
            if not isinstance(source, exp.Table) or not isinstance(source_node, exp.Table):
                raise PolicyError("unresolved relation source is prohibited")
            relation = _normalized_table(source)
            if relation not in allowed:
                raise PolicyError(f"relation is not allowlisted: {relation}")
            alias = visible_alias.lower()
            if not alias:
                raise PolicyError("relation alias could not be resolved")
            relations.append(relation)
            for column in protected.get(relation, ()):
                if not _predicate_on_every_path(query_filter, alias, column):
                    raise PolicyError(
                        f"protected relation alias {alias} lacks required direct partition predicate {column}: {relation}"
                    )
    statement_class = "explain_analyze_select" if analyze else "explain_select" if explain else "select"
    return ValidatedQuery(
        sql=sql,
        executing=not explain or analyze,
        explain=explain,
        analyze=analyze,
        statement_class=statement_class,
        relations=tuple(dict.fromkeys(relations)),
    )
