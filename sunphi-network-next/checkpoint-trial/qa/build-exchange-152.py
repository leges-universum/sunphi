"""Rebuild Home from the two published 0.3.151 archives."""
import argparse
import json
from pathlib import Path
import runpy

version = "0.3.152"
pins = {
    ("home", "windows-x64"): "2cdc52cfcb91b8efcb8bffada55a85314caff5b318f861d9d93ed67b704e42c7",
    ("home", "linux-x64"): "a3ab80b2f3ded2c8aa6bb07827b1a941c5a8d496e657cba178e7a87ac4b0114f",
}
parser = argparse.ArgumentParser(description=__doc__)
for name in ("previous_index", "output", "rcedit"):
    parser.add_argument(name, type=Path)
parser.add_argument("--copy", action="store_true")
args = parser.parse_args()
build = runpy.run_path(str(Path(__file__).with_name("build-settlement-151.py")))["build"]
previous = json.loads(args.previous_index.read_bytes())
homes = [row for row in previous["releases"] if row["edition"] == "home"]
assert previous["version"] == "0.3.151" and {row["platform"] for row in homes} == {p for _, p in pins} and len(homes) == 2
args.output.mkdir()
packs = []
for row in homes:
    pack = build(row, args.output, args.rcedit, args.copy, version=version, pins=pins, wallet_patch="exchange-prices-152.patch")
    packs.append(pack)
    print(pack["platform"], pack["sha256"], flush=True)
(args.output / "release.json").write_text(json.dumps({"version": version, "releases": packs}, indent=2), encoding="utf8")
