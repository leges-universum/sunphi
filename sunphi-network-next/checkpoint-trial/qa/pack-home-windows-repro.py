"""Create a Windows Home archive with stable entry ordering, timestamps and attributes."""
import shutil
import sys
import zipfile
from pathlib import Path

folder, archive = map(Path, sys.argv[1:])
with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED) as result:
    for path in sorted(folder.rglob("*"), key=lambda p: p.relative_to(folder).as_posix()):
        if path.is_dir():
            continue
        assert path.is_file() and not path.is_symlink()
        item = zipfile.ZipInfo((Path(folder.name) / path.relative_to(folder)).as_posix())
        item.create_system = 0
        item.external_attr = 32
        item.compress_type = zipfile.ZIP_DEFLATED
        item.file_size = path.stat().st_size
        with path.open("rb") as source, result.open(item, "w") as target:
            shutil.copyfileobj(source, target, 1024 * 1024)
