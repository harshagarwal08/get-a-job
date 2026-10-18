"""Run python-jobspy once and print the results as a JSON array on stdout.

Invoked by src/scrape/providers/jobspy.js as:
  uvx --python 3.12 --with python-jobspy==<pinned> python jobspy_runner.py '<args-json>'

args: {"sites": [...], "search_term": str, "location": str, "results_wanted": int,
       "hours_old": int, "country_indeed": str | null}
Diagnostics go to stderr; stdout is only the JSON array.
"""
import json
import math
import sys
from datetime import date, datetime


def clean(value):
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if hasattr(value, "isoformat"):  # pandas Timestamp
        try:
            return value.isoformat()
        except Exception:
            return str(value)
    if hasattr(value, "item"):  # numpy scalar
        try:
            return clean(value.item())
        except Exception:
            return str(value)
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    return value


def main():
    args = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    from jobspy import scrape_jobs  # imported late so arg errors surface first

    kwargs = {
        "site_name": args.get("sites") or ["indeed"],
        "search_term": args.get("search_term") or "",
        "location": args.get("location") or "",
        "results_wanted": int(args.get("results_wanted") or 20),
        "hours_old": int(args.get("hours_old") or 168),
        "linkedin_fetch_description": False,
        "verbose": 0,
    }
    if args.get("country_indeed"):
        kwargs["country_indeed"] = args["country_indeed"]
    df = scrape_jobs(**kwargs)
    records = [] if df is None else df.to_dict(orient="records")
    out = [{k: clean(v) for k, v in r.items()} for r in records]
    json.dump(out, sys.stdout, ensure_ascii=False, default=str)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"jobspy_runner error: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(2)
