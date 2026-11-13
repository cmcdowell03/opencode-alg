import hashlib, json, pathlib, re, sys

source = pathlib.Path(sys.argv[1]).resolve()
repo = pathlib.Path(sys.argv[2]).resolve()
target = repo / "docs/evidence/hard-scope-20261113"
if target.exists():
    raise SystemExit("refusing to overwrite prior evidence")
raw = json.loads((source / "result.json").read_text(encoding="utf-8-sig"))
assert raw["issued"] == 12 and raw["complete"] and raw["fatal"] is None
assert raw["source_unchanged"] and raw["global_configuration_unchanged"]
assert raw["suite_cleanup_errors"] == []
assert len(raw["results"]) == 12
assert not list(source.rglob("auth.json")), "temporary auth remains"
rows = []
for row in raw["results"]:
    assert all(row[k] for k in ["cleanup", "auth_copy_removed", "source_unchanged"])
    assert row["databaseCensus"]["qualified"] and row["final_census"]["quiescent"]
    statuses = [item["status"] for item in row["alg_states"]]
    rows.append({
        "case": row["caseId"], "arm": row["arm"], "status": row["status"],
        "artifact_passed": row["independent_score"]["passed"],
        "recorded_scored_task_success": row["scored_task_success"],
        "alg_statuses": statuses,
        "artifact_and_alg_done": bool(row["independent_score"]["passed"] and statuses and all(s == "done" for s in statuses)),
        "stop_reason": row["stopReason"], "wall_ms": row["wall_ms"],
        "failed_checks": [c["id"] for c in row["independent_score"]["checks"] if not c["passed"]],
        "reported_usage_components": row["metrics"]["usage"]["totalReportedTokens"],
        "compactions": row["retention"].get("compactions"),
        "retention_status": row["retention"].get("status"),
    })
aggregate = {}
for arm in ["build", "alg_default"]:
    selected = [r for r in rows if r["arm"] == arm]
    aggregate[arm] = {
        "issued": len(selected), "completed": sum(r["status"] == "completed" for r in selected),
        "artifact_passed": sum(r["artifact_passed"] for r in selected),
        "recorded_scored_task_success": sum(r["recorded_scored_task_success"] for r in selected),
        "artifact_and_alg_done": sum(r["artifact_and_alg_done"] for r in selected) if arm == "alg_default" else None,
        "reported_usage_components": sum(r["reported_usage_components"] for r in selected),
    }
errors = []
for name in ["05-alg", "05-bld", "06-bld"]:
    messages = json.loads((source / name / "messages.json").read_text(encoding="utf-8-sig"))
    for message in messages:
        error = message.get("info", {}).get("error")
        if not error:
            continue
        data = error.get("data", {})
        errors.append({"arm": name, "name": error.get("name"), "status_code": data.get("statusCode"),
            "usage_limit_message": bool(re.search(r"usage.limit|usage_limit|credits|quota", data.get("message", ""), re.I))})
assert errors and all(e["status_code"] == 429 and e["usage_limit_message"] for e in errors)
analysis = {
    "source_commit": "aff246995b763d871d1ebffda2ae8da91cc2ace7",
    "qualification": "same-user development; not confirmation",
    "aggregate": aggregate, "rows": rows, "provider_errors_safe_projection": errors,
    "cleanup": {"all_receipts_passed": True, "temporary_auth_files_found": 0},
    "interpretation": [
        "All twelve issued arms retained. Original grades are unchanged.",
        "01-alg fails an undisclosed exact-key rule: extra explanation fields, all other checks pass. Do not count it as an evidenced semantic checker false-pass.",
        "03-alg produces a passing artifact but stops with pending checker repair after max_waves=2; two original global attempts remain.",
        "05-alg has a correct artifact but its graph failed amid HTTP 429 usage-limit responses. 05-bld and 06-bld also hit HTTP 429; 06-alg timed out before a root session was created.",
        "11 armed host censuses have zero observed compaction markers; the unstarted arm has no retention observation. No obligation probes or information-loss estimate.",
        "Reported usage is session telemetry, including cached input, not provider invoice completeness.",
        "No superiority conclusion, selective replay, score replacement, or second comparison on revised contracts."
    ],
}
target.mkdir(parents=True)
manifest = []
for filename in ["result.json", "plan.json", "hard-qualification.json"]:
    data = (source / filename).read_bytes()
    assert not re.search(rb"(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|Bearer [A-Za-z0-9_.-]{20,}|-----BEGIN .*PRIVATE KEY-----)", data), "credential-shaped evidence"
    (target / filename).write_bytes(data)
    manifest.append({"path": filename, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
for name, data in [
    ("analysis.json", (json.dumps(analysis, indent=2) + "\n").encode()),
    ("collector.py", pathlib.Path(__file__).read_bytes()),
]:
    (target / name).write_bytes(data)
    manifest.append({"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
private = []
for name in ["hard-fixtures.json", "01-alg/messages.json", "03-alg/messages.json", "05-alg/messages.json", "05-bld/messages.json", "06-bld/messages.json"]:
    data = (source / name).read_bytes()
    private.append({"local_relative_path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
(target / "manifest.json").write_text(json.dumps({"files": manifest, "retained_locally_not_uploaded": private}, indent=2) + "\n")
print(json.dumps({"target": str(target), "aggregate": aggregate, "files": len(manifest)}))
