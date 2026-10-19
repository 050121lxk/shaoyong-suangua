"""Regenerate browser calendar regression fixtures using the original Python engine."""
import importlib.util
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("qigua", ROOT / "scripts" / "qigua.py")
qigua = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qigua)
dates = [
    "2026-10-16T19:37", "2025-12-02T20:51", "2025-04-15T12:00",
    "2025-01-28T23:59", "2025-01-29T00:00",  # Spring Festival
    "2024-02-04T16:00", "2024-02-04T17:00",  # Lichun
    "2025-02-03T22:00", "2025-02-03T23:00",
    "2025-07-25T12:00", "2025-08-01T12:00",  # leap sixth month
    "2026-10-16T22:59", "2026-10-16T23:00", "2026-10-16T23:59", "2026-10-17T00:00",
    "2026-10-08T00:00", "2026-10-08T23:00",  # jieqi month boundary
    "2024-02-29T00:30", "2023-12-31T23:59", "2024-01-01T00:00",
]
rename = {
    "lunar_year_zhi": "lunarYearZhi", "lunar_month": "lunarMonth", "leap": "leap",
    "lunar_day": "lunarDay", "hour_num": "hourNum", "year_gz": "yearGz",
    "month_gz": "monthGz", "day_gz": "dayGz", "hour_gz": "hourGz",
}
fixtures = []
for date in dates:
    info = qigua.time_info(datetime.strptime(date, "%Y-%m-%dT%H:%M"))
    base = qigua.ZHI.index(info["lunar_year_zhi"]) + 1 + info["lunar_month"] + info["lunar_day"]
    fixtures.append({"date": date, "info": {rename[k]: v for k, v in info.items()},
                     "board": [qigua.mod(base, 8), qigua.mod(base + info["hour_num"], 8),
                               qigua.mod(base + info["hour_num"], 6)]})
(ROOT / "tests" / "calendar-fixtures.json").write_text(json.dumps(fixtures, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Wrote {len(fixtures)} calendar regression fixtures.")
