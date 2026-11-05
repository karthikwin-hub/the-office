"""Recalculate every exported workbook in LibreOffice and check each formula
gives the same value the engine cached. A clean recalc proves the formulas
evaluate; this proves they compute what the engine computes.

    EXPORT_DIR=/tmp/office-exports pnpm --filter @office/engine test
    .venv/bin/python tools/exports/verify.py /tmp/office-exports
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parents[2]
RECALC = ROOT / ".cursor/skills/xlsx/scripts/recalc.py"


def cached(path: Path) -> dict[tuple[str, str], object]:
    formulas = load_workbook(path)
    values = load_workbook(path, data_only=True)
    out = {}
    for ws in formulas.worksheets:
        for row in ws.iter_rows():
            for c in row:
                if isinstance(c.value, str) and c.value.startswith("="):
                    out[(ws.title, c.coordinate)] = values[ws.title][c.coordinate].value
    return out


def main(folder: str) -> int:
    failures = 0
    files = sorted(Path(folder).glob("*.xlsx"))
    if not files:
        print(f"No workbooks in {folder}")
        return 1
    for src in files:
        expected = cached(src)
        work = src.with_suffix(".recalc.xlsx")
        shutil.copy(src, work)
        res = json.loads(subprocess.run([sys.executable, str(RECALC), str(work), "60"], capture_output=True, text=True).stdout)
        if res.get("status") != "success":
            print(f"{src.name}: {res}")
            failures += 1
            continue
        got = load_workbook(work, data_only=True)
        diffs = []
        for (sheet, ref), want in expected.items():
            have = got[sheet][ref].value
            if want is None or have is None or abs(float(have) - float(want)) > 0.005:
                diffs.append(f"{sheet}!{ref} engine {want} LibreOffice {have}")
        work.unlink()
        print(f"{src.name}: {res['total_formulas']} formulas, {len(diffs)} differences")
        for d in diffs[:10]:
            print("  " + d)
        failures += bool(diffs)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/office-exports"))
