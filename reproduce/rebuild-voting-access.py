"""Rebuild a DueByte 0.3.148 package from the corresponding 0.3.147 archive and release tag."""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def check(file, expected):
    if digest(file) != expected:
        raise ValueError(f"Unexpected SHA-256 for {file.name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("predecessor", type=Path)
    parser.add_argument("destination", type=Path, help="fresh output directory")
    parser.add_argument("--rcedit", type=Path, help="Windows resource editor for Windows Home")
    args = parser.parse_args()
    kit = Path(__file__).resolve().parent
    repo = kit.parent
    previous = args.predecessor.resolve()
    prefix = Path("sunphi-network-next/checkpoint-trial")
    pins = {
        "DueByte-Home-0.3.147-Windows-x64.zip": "0652608bbb96647c4a2b56ab443643a6d5fc1881eb0c57af3fb3ab5c8e56dbff",
        "DueByte-Home-0.3.147-Linux-x64.tar.gz": "fe2f287072990e4be81e3e71e8753fb4adb44c252777cff658e3424535b88758",
        "DueByte-Server-0.3.147-Linux-x64.tar.gz": "d5a1864743937e2557d834642b90cbbf37837dd3d6d1f86c4ccc725b262c8806",
    }
    check(previous, pins[previous.name])
    windows = previous.suffix == ".zip"
    home = "-Home-" in previous.name
    if windows:
        if not args.rcedit:
            parser.error("--rcedit is required for Windows Home")
        check(args.rcedit, "e2df7b664db830f159d0dc6b3da8a95442cca175b9577f2d19952646d37ac32f")
    new_version = "0.3.148"
    archive_name = previous.name.replace("0.3.147", new_version)
    release = json.loads((repo / "RELEASE.json").read_bytes())
    if release["version"] != new_version:
        raise ValueError("Expected the duebyte-v0.3.148 release sources")
    target = next(p for p in release["files"] if p["name"] == archive_name)
    destination = args.destination.resolve()
    destination.mkdir()
    subprocess.run(["tar", "-xf", previous, "-C", destination], check=True)
    suffix = ".zip" if windows else ".tar.gz"
    folder = destination / archive_name.removesuffix(suffix)
    (destination / previous.name.removesuffix(suffix)).rename(folder)
    root = folder / "resources/app" if windows else folder
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    overlay = [prefix / "research/operator-ballots.mjs"]
    if home:
        overlay.extend(prefix / name for name in ("client.mjs", "wallet-server.mjs", "wallet.html"))
    versioned = [Path("release-config.json"), Path("package.json"), prefix / "consumer.html"]
    if not home:
        versioned.append(prefix / "wallet.html")
    if not windows:
        versioned.append(Path("install.sh"))
    for relative in overlay + versioned:
        file = root / relative
        name = relative.as_posix()
        check(file, manifest["files"][name])
        data = (repo / relative).read_bytes() if relative in overlay else file.read_bytes().replace(b"0.3.147", new_version.encode())
        file.write_bytes(data)
        manifest["files"][name] = digest(file)
    intro = folder / "START-HERE.txt"
    intro.write_bytes(intro.read_bytes().replace(b"0.3.147", new_version.encode()))
    manifest["version"] = new_version
    manifest_path.write_bytes(json.dumps(manifest, ensure_ascii=False, indent=2).encode())
    check(manifest_path, target["manifestSha256"])
    archive = destination / archive_name
    if windows:
        subprocess.run([args.rcedit.resolve(), folder / "DueByte.exe", "--set-file-version", new_version,
                        "--set-product-version", new_version], check=True)
        pack = [kit / "pack-home-windows-repro.py", folder, archive]
    else:
        pack = [kit / "pack-home-linux-overlay.py", previous, folder, archive]
    subprocess.run([sys.executable, *pack], check=True)
    check(archive, target["sha256"])
    print(target["sha256"], archive.name)


if __name__ == "__main__":
    main()
