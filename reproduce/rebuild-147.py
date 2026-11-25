"""Reproduce one named DueByte 0.3.147 distribution from its pinned predecessor."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

PINS = {
    "DueByte-Home-0.3.146-Windows-x64.zip": (
        "5d9530843519c641b857048174b29ed7bbdcfbae6e35b8c86c1dba65d1e26bd7",
        "0652608bbb96647c4a2b56ab443643a6d5fc1881eb0c57af3fb3ab5c8e56dbff"),
    "DueByte-Home-0.3.146-Linux-x64.tar.gz": (
        "aec6eed983a84f693cfc1036e6382a99fd42931132988469e8b5a733b7c3ea66",
        "fe2f287072990e4be81e3e71e8753fb4adb44c252777cff658e3424535b88758"),
    "DueByte-Server-0.3.145-Linux-x64.tar.gz": (
        "e0e5b14e35060bf949b1e2b9ef098a509daed3e89db63e3932b0d630fc198eeb",
        "d5a1864743937e2557d834642b90cbbf37837dd3d6d1f86c4ccc725b262c8806"),
}

def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def check(path, expected):
    if digest(path) != expected:
        raise ValueError(f"SHA-256 mismatch for {path.name}")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("previous", type=Path)
    parser.add_argument("bridge", type=Path)
    parser.add_argument("destination", type=Path, help="new directory")
    parser.add_argument("--rcedit", type=Path, help="required for Windows Home")
    args = parser.parse_args()
    previous = args.previous.resolve()
    before, after = PINS[previous.name]
    check(previous, before)
    windows = previous.name.endswith(".zip")
    suffix = ".zip" if windows else ".tar.gz"
    base = previous.name.split("-")[2]
    check(args.bridge, "bafd7d7ee04e2184b7dca18d7a5926391149a43dce3f2b884f7e7df535e8db8a" if windows else
          "8ce3360d1bc51056eb176ddfec68bd2824e9c6285cecd7a5e0dd2fdd4257f42a")
    if windows:
        if args.rcedit is None:
            parser.error("--rcedit is required for Windows Home")
        check(args.rcedit, "e2df7b664db830f159d0dc6b3da8a95442cca175b9577f2d19952646d37ac32f")
    version = "0.3.147"
    target = args.destination.resolve()
    target.mkdir()
    subprocess.run(["tar", "-xf", str(previous), "-C", str(target)], check=True)
    old = target / previous.name.removesuffix(suffix)
    folder = old.with_name(old.name.replace(base, version))
    old.rename(folder)
    root = folder / "resources/app" if windows else folder
    prefix = Path("sunphi-network-next/checkpoint-trial")
    kit = Path(__file__).resolve().parent
    manifest_file = root / "manifest.json"
    manifest = json.loads(manifest_file.read_bytes())
    def update(name, data):
        relative = Path(name).as_posix()
        check(root / name, manifest["files"][relative])
        (root / name).write_bytes(data)
        manifest["files"][relative] = digest(root / name)
    for file in ["economic-policy-v3.mjs", "economic-preparation.mjs", "emission-calendar.mjs",
                 "research/bounded-network-interpreter.mjs"]:
        update(prefix / file, (kit / "overlay" / file).read_bytes())
    update(prefix / "build" / ("duebyte-abci.exe" if windows else "duebyte-abci"), args.bridge.read_bytes())
    names = [prefix / "wallet.html", prefix / "consumer.html", "release-config.json", "package.json"]
    if not windows:
        names.append("install.sh")
    for name in names:
        data = (root / name).read_bytes()
        if base.encode() not in data:
            raise ValueError(f"Missing predecessor version in {name}")
        update(name, data.replace(base.encode(), version.encode()))
    intro = folder / "START-HERE.txt"
    intro.write_bytes(intro.read_bytes().replace(base.encode(), version.encode()))
    manifest["version"] = version
    manifest_file.write_bytes(json.dumps(manifest, ensure_ascii=False, indent=2).encode())
    archive = target / (folder.name + suffix)
    if windows:
        subprocess.run([str(args.rcedit.resolve()), str(folder / "DueByte.exe"), "--set-file-version", version,
                        "--set-product-version", version], check=True)
        pack = ["pack-home-windows-repro.py", folder, archive]
    else:
        pack = ["pack-home-linux-overlay.py", previous, folder, archive]
    subprocess.run([sys.executable, kit / pack[0], *pack[1:]], check=True)
    check(archive, after)
    print(f"{after}  {archive.name}")

if __name__ == "__main__":
    main()
