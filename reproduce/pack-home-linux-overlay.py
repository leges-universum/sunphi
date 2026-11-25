"""Write a candidate using the verified base archive's paths and Unix modes."""
import copy
import gzip
import os
import sys
import tarfile
from pathlib import Path, PurePosixPath

previous, folder, destination, *added = sys.argv[1:]
folder = Path(folder)
target = Path(destination + ".building")
seen = set()
with tarfile.open(previous, "r:gz") as source, target.open("xb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", compresslevel=4, mtime=0) as compressed, tarfile.open(fileobj=compressed, mode="w|") as archive:
    for member in source:
        parts = PurePosixPath(member.name).parts
        assert parts and not member.name.startswith("/") and ".." not in parts
        relative = Path(*parts[1:])
        assert relative not in seen and (member.isdir() or member.isfile())
        seen.add(relative)
        entry = copy.copy(member)
        entry.name = (Path(folder.name) / relative).as_posix()
        # tarfile will encode the new long path. The previous PAX path would
        # override entry.name when a native Linux updater extracts the archive.
        entry.pax_headers = {key: value for key, value in member.pax_headers.items() if key != "path"}
        if member.isdir():
            archive.addfile(entry)
        else:
            with (folder / relative).open("rb") as content:
                entry.size = os.fstat(content.fileno()).st_size
                archive.addfile(entry, content)
    for name in added:
        relative = Path(name)
        assert not relative.is_absolute() and ".." not in relative.parts and relative not in seen
        entry = tarfile.TarInfo((Path(folder.name) / relative).as_posix())
        entry.mode = 0o644
        with (folder / relative).open("rb") as content:
            entry.size = os.fstat(content.fileno()).st_size
            archive.addfile(entry, content)
os.replace(target, destination)
