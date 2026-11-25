# Reproduce DueByte Home and Server 0.3.147

Use the files in this directory from the release tag, preserving file bytes and line endings. The named Home 0.3.146 and Server 0.3.145 release assets provide the inherited application and third-party runtimes. The comparator pins the input archives, bridge executables, Windows resource editor and final archive hashes. The historical update metadata is available at commit `c16426909c49e980ff7ac71fc8ce8037eb873e02` on the public update channel.

## Build the bridge

On Linux with Go 1.27.3, start in this directory. Go verifies dependencies against the included module checksums.

```sh
mkdir build
cd bridge
export GOARCH=amd64 CGO_ENABLED=0 GOTOOLCHAIN=local
GOOS=linux go build -trimpath -mod=readonly -buildvcs=false -o ../build/duebyte-abci .
GOOS=windows go build -trimpath -mod=readonly -buildvcs=false -o ../build/duebyte-abci.exe .
cd ..
```

## Rebuild complete archives

The reference builds used Windows x64, CPython 3.14.2 with zlib runtime `1.3.1.zlib-ng` and the Windows tar utility. The Windows resource editor is distributed as `vendor/rcedit.exe` in electron-winstaller. Its required SHA-256 is `e2df7b664db830f159d0dc6b3da8a95442cca175b9577f2d19952646d37ac32f`. Place the bridge outputs in `build`, provide the named predecessor files and select a fresh output directory for each command.

```powershell
python rebuild-147.py DueByte-Home-0.3.146-Windows-x64.zip build/duebyte-abci.exe home-windows --rcedit vendor/rcedit.exe
python rebuild-147.py DueByte-Home-0.3.146-Linux-x64.tar.gz build/duebyte-abci home-linux
python rebuild-147.py DueByte-Server-0.3.145-Linux-x64.tar.gz build/duebyte-abci server-linux
```

Each command verifies the final archive and prints its SHA-256. A different compression implementation can produce a different digest even with identical extracted files. Rebuilding inherited Electron, Node.js and historical compatibility binaries from upstream sources is outside this comparison. Package authenticity for installation is established by the signed update metadata.
