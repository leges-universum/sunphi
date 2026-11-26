"""Build the three settlement release candidates from pinned complete packages."""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

VERSION = "0.3.151"
QA = Path(__file__).resolve().parent
PREFIX = "sunphi-network-next/checkpoint-trial/"
CRM = QA.parents[2] / "duebyte-node-installer-20261119/reward-reserve/pilot-evidence/tryton-crm"
PINS = {
    ("home", "windows-x64"): "14cbd8be8fffc8bcc723102c498cdd3665a6bcaaa7f34428b7b14cc22c017e5c",
    ("home", "linux-x64"): "621b23bffbae435575fda8e666fad31a69eb10af16d8d32a1f41839d8e9420c1",
    ("server", "linux-x64"): "6889cbe52567085c75965c473d6e5a62a79704738ede829e5a9498f1279fe664",
}

def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def wallet_overlay(data, patch_file="settlement-wallet-151.patch"):
    source = data.decode().splitlines(keepends=True)
    patch = (QA / patch_file).read_text(encoding="utf-8").splitlines()[2:]
    output = []
    cursor = 0
    for line in patch:
        if line.startswith("@@"):
            match = re.fullmatch(r"@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@.*", line)
            if not match:
                raise ValueError("Invalid wallet change")
            at = int(match[1]) if match[2] == "0" else int(match[1])-1
            assert at >= cursor
            output.extend(source[cursor:at])
            cursor = at
        elif line.startswith("-"):
            assert source[cursor].rstrip("\r\n") == line[1:]
            cursor += 1
        elif line.startswith("+"):
            output.append(line[1:] + "\n")
        else:
            raise ValueError("Unexpected wallet change")
    return "".join(output + source[cursor:]).encode()

def build(prior, out, rcedit, copy=False, *, version=VERSION, pins=PINS, wallet_patch="settlement-wallet-151.patch"):
    edition, platform = prior["edition"], prior["platform"]
    previous, archive = Path(prior["folder"]), Path(prior["archive"])
    assert digest(archive) == pins[edition, platform]
    old = prior["version"]
    win = platform == "windows-x64"
    inner = Path("resources/app") if win else Path()
    oldroot = previous / inner
    assert digest(oldroot / "manifest.json") == prior["manifestSha256"]
    manifest = json.loads((oldroot / "manifest.json").read_bytes())
    for filename, expected in manifest["files"].items():
        assert digest(oldroot / filename) == expected, filename
    folder = out / previous.name.replace(old, version)
    root = folder / inner
    versioned = ["release-config.json", "package.json", PREFIX+"consumer.html", PREFIX+"wallet.html"]
    if not win:
        versioned.append("install.sh")
    changed = {str(inner / f) for f in versioned + ["manifest.json"]} | {"START-HERE.txt", "DueByte.exe"}
    def copyfile(src, dest):
        if copy or str(Path(src).relative_to(previous)) in changed:
            return shutil.copy2(src, dest)
        return os.link(src, dest)
    shutil.copytree(previous, folder, copy_function=copyfile)
    for name in versioned:
        file = root / name
        data = file.read_bytes()
        if name == PREFIX+"wallet.html" and edition == "home":
            data = wallet_overlay(data, wallet_patch)
        assert old.encode() in data, name
        file.write_bytes(data.replace(old.encode(), version.encode()))
        manifest["files"][name] = digest(file)
    additions = {}
    if edition == "server":
        for name in ("invoice-receipt.mjs", "invoice-settlement-reader.mjs"):
            additions[PREFIX+name] = QA.parent / name
        for module in ("duebyte_import", "duebyte_ledger"):
            for name in ("__init__.py", "tryton.cfg", "ledger.py" if module == "duebyte_ledger" else "receipt.py"):
                additions["integrations/tryton/"+module+"/"+name] = CRM / module / name
        additions["integrations/tryton/README.md"] = CRM / "SERVER-INTEGRATION.md"
    for name, source in additions.items():
        file = root / name
        assert not file.exists()
        file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, file)
        manifest["files"][name] = digest(file)
    intro = folder / "START-HERE.txt"
    info = intro.read_bytes().replace(old.encode(), version.encode())
    if edition == "server":
        info += b"\nFor native invoice reconciliation, see integrations/tryton/README.md.\n"
    intro.write_bytes(info)
    manifest["version"] = version
    mf = root / "manifest.json"
    mf.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf8",newline="\n")
    result = out / (folder.name + (".zip" if win else ".tar.gz"))
    if win:
        assert digest(rcedit) == "e2df7b664db830f159d0dc6b3da8a95442cca175b9577f2d19952646d37ac32f"
        subprocess.run([rcedit, folder/"DueByte.exe", "--set-file-version",version,"--set-product-version",version],check=True)
        pack = [QA/"pack-home-windows-repro.py", folder, result]
    else:
        pack = [QA/"pack-home-linux-overlay.py", archive, folder, result, *additions]
    subprocess.run([sys.executable,*pack],check=True)
    return {**prior, "version":version,"folder":str(folder),"archive":str(result),"sha256":digest(result),
            "manifestSha256":digest(mf),"bytes":result.stat().st_size}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("home_index","server_index","output","rcedit"):
        parser.add_argument(arg,type=Path)
    parser.add_argument("--copy",action="store_true",help="Copy immutable files when building on another volume.")
    args = parser.parse_args()
    args.output.mkdir()
    results = []
    for edition,index in (("home",args.home_index),("server",args.server_index)):
        for prior in json.loads(index.read_bytes())["releases"]:
            if prior["edition"] == edition:
                results.append(build(prior,args.output,args.rcedit,args.copy))
                print(results[-1]["platform"],results[-1]["edition"],results[-1]["sha256"],flush=True)
    assert len(results)==3
    (args.output/"release.json").write_text(json.dumps({"version":VERSION,"releases":results},indent=2),encoding="utf8")
