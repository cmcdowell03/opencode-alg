from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[2]
CAPABILITY = ROOT / "capabilities" / "excel"
sys.path.insert(0, str(CAPABILITY))

import policy  # noqa: E402
import workbook  # noqa: E402


def write_xlsx(path: Path, formulas: list[str] | None = None, *, external: bool = False) -> None:
    formulas = formulas or []
    cells = []
    for index, formula in enumerate(formulas, 1):
        cells.append(f'<c r="A{index}"><f>{escape(formula)}</f><v>0</v></c>')
    if not cells:
        cells.append('<c r="A1" t="inlineStr"><is><t>safe</t></is></c>')
    final_row = max(1, len(cells))
    external_rel = (
        '<Relationship Id="rIdExternal" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" '
        'Target="https://example.invalid/book.xlsx" TargetMode="External"/>'
        if external else ""
    )
    parts = {
        "[Content_Types].xml": """<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>""",
        "xl/workbook.xml": """<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
  <calcPr calcMode="auto" fullCalcOnLoad="1"/>
</workbook>""",
        "xl/_rels/workbook.xml.rels": f"""<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  {external_rel}
</Relationships>""",
        "xl/worksheets/sheet1.xml": f"""<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:A{final_row}"/>
  <sheetData><row r="1">{''.join(cells)}</row></sheetData>
</worksheet>""",
    }
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(parts):
            archive.writestr(name, parts[name])


class ExcelPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="alg-excel-policy-")
        self.base = Path(self.temporary.name)
        self.root = self.base / "dedicated root"
        self.root.mkdir()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_relative_in_root_and_fail_closed_inputs(self) -> None:
        nested = self.root / "nested"
        nested.mkdir()
        resolved = policy.resolve_workbook(str(self.root.resolve()), "nested/book.XLSX")
        self.assertEqual(Path(resolved), nested / "book.XLSX")
        for value in (
            str((self.root / "absolute.xlsx").resolve()),
            "../escape.xlsx",
            "nested/../../escape.xlsx",
            "bad\x00.xlsx",
            "book.xlsm",
            "book.xlsx:stream",
            "NUL.xlsx",
            "CON.xlsx",
            "con.foo.xlsx",
            "COM1.xlsx",
            "LPT9.xlsx",
            "COM¹.xlsx",
            "com².foo.xlsx",
            "COM³.xlsx",
            "LPT¹.xlsx",
            "lpt².foo.xlsx",
            "LPT³.xlsx",
            "nested/COM¹/book.xlsx",
            "nested/lpt³.foo/book.xlsx",
            "COM¹.xlsx. ",
            "nested/AUX/book.xlsx",
            "nested/PRN.foo/book.xlsx",
            "book.xlsx.",
            "book.xlsx ",
            "nested./book.xlsx",
            "nested /book.xlsx",
        ):
            with self.subTest(value=value):
                with self.assertRaises(policy.ExcelPolicyError):
                    policy.resolve_workbook(str(self.root.resolve()), value)
        for value in ("connection.xlsx", "com10.xlsx", "lpt10.xlsx", "auxiliary.xlsx", "nested/normal.xlsx"):
            with self.subTest(normal=value):
                parent = self.root / "nested" if value.startswith("nested/") else self.root
                parent.mkdir(exist_ok=True)
                self.assertTrue(policy.resolve_workbook(str(self.root.resolve()), value).lower().endswith(".xlsx"))

    def test_symlink_escape_is_rejected_when_supported(self) -> None:
        outside = self.base / "outside"
        outside.mkdir()
        link = self.root / "linked"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("directory symlinks are unavailable")
        with self.assertRaises(policy.ExcelPolicyError):
            policy.resolve_workbook(str(self.root.resolve()), "linked/escape.xlsx")

    def test_root_check_has_deterministic_rejection_inventory(self) -> None:
        first = policy.policy_check(str(self.root.resolve()))
        second = policy.policy_check(str(self.root.resolve()))
        self.assertEqual(first, second)
        self.assertEqual(first["rejected"], sorted(first["rejected"]))


class WorkbookUtilityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="alg-excel-workbook-")
        self.base = Path(self.temporary.name)
        self.root = self.base / "root with spaces"
        self.root.mkdir()
        self.source = self.base / "source.xlsx"
        write_xlsx(self.source)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_stage_is_copy_only_atomic_and_requires_explicit_overwrite(self) -> None:
        before = self.source.read_bytes()
        staged = workbook.stage(str(self.root.resolve()), str(self.source.resolve()), "copy.xlsx")
        self.assertTrue(staged["source_unchanged"])
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual((self.root / "copy.xlsx").read_bytes(), before)
        self.assertEqual(list(self.root.glob(".alg-excel-stage-*")), [])
        with self.assertRaises(policy.ExcelPolicyError):
            workbook.stage(str(self.root.resolve()), str(self.source.resolve()), "copy.xlsx")
        replacement = self.base / "replacement.xlsx"
        write_xlsx(replacement, ["=1+1"])
        workbook.stage(str(self.root.resolve()), str(replacement.resolve()), "copy.xlsx", True)
        self.assertEqual((self.root / "copy.xlsx").read_bytes(), replacement.read_bytes())
        self.assertEqual(self.source.read_bytes(), before)

    def test_validator_is_deterministic_and_never_claims_recalculation(self) -> None:
        workbook.stage(str(self.root.resolve()), str(self.source.resolve()), "safe.xlsx")
        first = workbook.validate(str(self.root.resolve()), "safe.xlsx")
        second = workbook.validate(str(self.root.resolve()), "safe.xlsx")
        self.assertEqual(first, second)
        self.assertTrue(first["ok"])
        self.assertEqual(first["calculation"]["freshness"], "not_verified")
        self.assertFalse(first["calculation"]["formulas_recalculated"])
        self.assertEqual(
            json.dumps(first, sort_keys=True, separators=(",", ":")),
            json.dumps(second, sort_keys=True, separators=(",", ":")),
        )

    def test_validator_flags_external_and_dangerous_formulas_case_insensitively(self) -> None:
        unsafe = self.base / "unsafe.xlsx"
        write_xlsx(unsafe, ["=webservice(\"https://example.invalid\")", "='[other.xlsx]S'!A1"], external=True)
        workbook.stage(str(self.root.resolve()), str(unsafe.resolve()), "unsafe.xlsx")
        result = workbook.validate(str(self.root.resolve()), "unsafe.xlsx")
        self.assertFalse(result["ok"])
        self.assertEqual(result["formulas"], 2)
        self.assertIn("WEBSERVICE", result["formula_findings"][0]["functions"])
        self.assertTrue(result["external_relationships"])
        self.assertNotIn("formula", result["formula_findings"][0])

    def test_validator_enforces_cell_bound_and_rejects_bad_zip(self) -> None:
        two = self.base / "two.xlsx"
        write_xlsx(two, ["=1", "=2"])
        workbook.stage(str(self.root.resolve()), str(two.resolve()), "two.xlsx")
        prior = workbook.MAX_CELLS
        workbook.MAX_CELLS = 1
        try:
            with self.assertRaises(workbook.WorkbookValidationError):
                workbook.validate(str(self.root.resolve()), "two.xlsx")
        finally:
            workbook.MAX_CELLS = prior
        malformed = self.root / "malformed.xlsx"
        malformed.write_bytes(b"not a zip")
        with self.assertRaises(workbook.WorkbookValidationError):
            workbook.validate(str(self.root.resolve()), "malformed.xlsx")


if __name__ == "__main__":
    unittest.main()
