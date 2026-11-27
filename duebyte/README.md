# DueByte protocol and verification

## Verify the stable release

Use the named archive from the [edition table](../README.md#review-the-stable-release). Extract it to a fresh directory. From this repository run the matching command with Node.js 24. Replace the last two arguments with your extracted application directory and the original downloaded file.

```sh
node duebyte/verify-release.mjs home-windows-x64 PATH/TO/DueByte-Home-0.3.152-Windows-x64/resources/app PATH/TO/DueByte-Home-0.3.152-Windows-x64.zip
node duebyte/verify-release.mjs home-linux-x64 PATH/TO/DueByte-Home-0.3.152-Linux-x64 PATH/TO/DueByte-Home-0.3.152-Linux-x64.tar.gz
node duebyte/verify-release.mjs server-linux-x64 PATH/TO/DueByte-Server-0.3.151-Linux-x64 PATH/TO/DueByte-Server-0.3.151-Linux-x64.tar.gz
```

The verifier pins the recorded catalog commit and release root, checks the Ed25519 targets threshold, then checks the descriptor, complete archive, application manifest, every manifest entry and the full inventory of published source files. For an independent trust check, compare the root digest in the verifier with the SHA-256 of `update-root.json` from a previously trusted installation. This procedure authenticates a historical snapshot. Released updaters check freshness and upgrade eligibility when installing.

The review trees contain the shipped application scripts, interface and integration source in the first-party application directories, including the compatibility reader. Binary executables, third-party runtimes, package configuration and build tools are available for inspection through the original release assets and tag recipes. The SHA-256 check covers the entire downloaded archive. See the [Home qualification record](https://github.com/leges-universum/sunphi/blob/duebyte-v0.3.152/reproduce/qualification-152.json) and [Server qualification record](https://github.com/leges-universum/sunphi/blob/duebyte-v0.3.151/reproduce/qualification-151.json).

To check the current Server monetary policy, run the following with the two public economics files linked below.

```sh
node duebyte/verify-economics.mjs PATH/TO/DueByte-Server-0.3.151-Linux-x64 economic-policy-v4.json ordinary-node-calendar.csv
```

## Earlier release evidence

The release catalog selects the software a node installs. Its target metadata identifies the archive and the digest of the file manifest. Each release archive contains the corresponding protocol modules. For a reproducible review, identify the catalog commit, target, version, manifest digest, network pin and block height. GitHub's automatically generated source archives describe the tag tree. Use the named Home and Server release assets for inspection of shipped software.

| Artifact | Purpose |
| --- | --- |
| [Stable channel](https://github.com/leges-universum/sunphi/tree/duebyte-updates-stable) | Signed update metadata and edition-specific targets |
| [Home and Server 0.3.147](https://github.com/leges-universum/sunphi/releases/tag/duebyte-v0.3.147) | Windows and Linux Home, Linux Server, checksums and installers |
| [Pinned catalog for 0.3.147](https://github.com/leges-universum/sunphi/tree/f6064319ff3310b6369b3ce00351554a4fe54615) | Role signatures, target hashes, network pin and edition-specific upgrade routes |
| [Build recipe and qualification record](https://github.com/leges-universum/sunphi/tree/duebyte-v0.3.147/reproduce) | Pinned archives, bridge source, deterministic packing tools, direct upgrade sources and test counts |
| [Predecessor catalog](https://github.com/leges-universum/sunphi/tree/c16426909c49e980ff7ac71fc8ce8037eb873e02/targets) | Signed selection of the Home 0.3.146 and Server 0.3.145 inputs |
| [V4 planning export](https://duebyte.com/economic-policy-v4.json) and [ordinary node schedule](https://duebyte.com/ordinary-node-calendar.csv) | Historical preparation example and smoothed annual budgets for 2027–2126 |
| [Research award proposal](https://duebyte.com/human-ai-research-fund-v2.json) | Proposed use of the restricted allocation, including governance and eligibility |

## Monetary rules

One DUBYT contains 1,000,000 base units. The century ceiling is 10,010,000,000 DUBYT. The main programme accounts for 10,000,000,000 DUBYT. The separate restricted allocation accounts for the remaining 10,000,000. The terminal pilot and previously issued balances must be reconciled within their respective allocations. A scheduled budget gives the upper amount available under its rules. An actual balance requires a verified ledger state.

| Source in the shipped Server under `sunphi-network-next/checkpoint-trial/` | Verification scope |
| --- | --- |
| `emission-calendar.mjs` | Historical whole-unit, 30-year profile with a 100 billion limit. Retained for historical software and replay. |
| `economic-policy-v2.mjs`, `economic-policy-v3.mjs` | Versioned preparation rules. V4 builds on the 10 billion programme and adds the restricted allocation exactly once. Signed V3 records retain their earlier amount. |
| `economic-preparation.mjs`, `research/bounded-reward-context.mjs`, `research/bounded-network-interpreter.mjs` | Preparation prevents legacy issuance activation. The bounded execution path checks legacy reward coefficients, issuance deltas and controller state. |
| `research/bounded-zero-stage-issuance.mjs`, `research/main-programme-transition.mjs`, `research/smooth-emission.mjs` | Pilot issuance, programme transition and the smoothed node allowance use distinct authority and accounting checks. |

In 0.3.147, the V4 state audit and bounded execution both convert the ledger supply to integer base units and compare it with 10,010,000,000,000,000. Bounded execution checks the state on entry and after applying each transaction frame or block frame, before committing its staged writes. The supply delta must agree with the authorized issuance counters. The indexed ledger also verifies conservation as balances move between accounts, payment reservations and custody. These checks cover signed actions, batched fault reports and automatic block processing, including blocks containing no user transaction.

The V4 planning export illustrates a starting balance of 2,000 DUBYT. The published ordinary schedule presents the full node allocation of 9,880,000,000 DUBYT. These inputs explain why adding the rows of the historical example produces a different total. The January 2027 programme transition has its own state and rules. The historical export's empty start date describes the preparation object. The Human–AI Research Fund proposal concerns the purpose of the existing restricted allocation. Execution of research awards requires separate authority and software support.

### Repeat the comparison

Download the named `DueByte-Server-0.3.147-Linux-x64.tar.gz` release asset and verify its SHA-256 before extracting into an empty directory. The reference archive digest is `d5a1864743937e2557d834642b90cbbf37837dd3d6d1f86c4ccc725b262c8806`. Save the two economic files linked above alongside it. With Node.js 24 run

```sh
node verify-economics.mjs DueByte-Server-0.3.147-Linux-x64 economic-policy-v4.json ordinary-node-calendar.csv
```

The verifier checks the pinned manifest and every listed file before loading the release planner. It compares the allocations, ten decade totals, 100 planning years and all 100 annual budgets and cumulative totals in the ordinary schedule using integer arithmetic. At every UTC midnight in the century it also checks that the cumulative allowance stays within the node budget and never decreases. This comparison establishes agreement for these artifacts. Exhaustive transition reachability and independent reconstruction of the release binaries require additional evidence.

## Trust and operational evidence

### Upgrade coverage for 0.3.147

On each Home platform, all 67 published storage-v1 source versions from 0.3.72 through 0.3.146 staged the real target archive. Each encrypted test wallet reopened with its previous key and history. Windows runs also exercised the released update helper and GUI readiness. Linux runs verified executable modes and the native entry point. Clients on 0.3.71 retain the signed history-reader transition through 0.3.72. Server uses explicit operator installation and records ten qualified predecessor manifests. A 0.3.124 Home with a failed 0.3.125 staging record recovered directly to the new target on both platforms.

### Signed application messages

Encode the schema-validated message as UTF-8. Objects use lexicographically sorted UTF-16 key sequences, with JSON string escaping for keys and values. Arrays retain element order. Object and array delimiters have no surrounding whitespace. Preserve Unicode sequences exactly. Integer JSON numbers are restricted to the JavaScript safe-integer range and use decimal notation, with zero encoded as `0`. Monetary strings retain their schema-defined decimal representation. Hash the encoded bytes with SHA-256 for application identifiers. Application Ed25519 signatures cover the encoded message bytes. CometBFT votes have their own signing format. Run `node verify-canonical.mjs SERVER_DIR` for executable application examples, including Unicode ordering and numeric boundaries.

| Authority | What the evidence establishes | Evidence still needed for economic operation |
| --- | --- | --- |
| Validators | Ed25519 precommits and voting power identify the signers of a block. A dated observation verified 264 signatures across 24 blocks, heights 129652–129675. | Identify independent beneficial control, hosting and recovery custody. Exercise quorum loss and recovery across those operators. |
| Checkpoint and client bootstrap | A pinned network and authenticated checkpoint give clients a starting state. | Demonstrate independent checkpoint verification and recovery from a separately administered archive. |
| Software releases | The reference catalog requires two of three keys for root and target metadata. Snapshot and timestamp metadata each require one key. | Separate signing custody, demonstrate loss and rotation of a release key, independently rebuild artifacts, and verify platform publisher signatures. |
| Fund and award administration | Protocol rules restrict balances, signatures and payment limits. | Document conflicts of interest, independent review of work coefficients, withdrawal controls and a funded procedure for claims. A protection reserve pays only under its rules and up to available funds. |

For Windows reviewers, `Test-WindowsPublishers.ps1` checks every executable, including compatibility copies, against Windows trust and a publisher thumbprint allowlist supplied independently for each binary name. A missing executable or unapproved signature fails the check. The Home 0.3.147 launcher and ABCI bridge lack Windows publisher signatures. Clients verify releases using the signed update channel. The controlled pilot and scheduled network programme are distinct from acceptance of customer money, lending authority or insurance coverage.

### Package and bridge build evidence

Two local builds of each complete 0.3.147 package and a third reconstruction using the public recipe produced matching archive bytes. Each of the two initial bridge builds had its own source directory and initially empty compilation cache. Both used the same verified Go 1.27.3 toolchain, module cache and host, with CGO disabled, read-only module versions, trimmed paths and VCS stamping disabled. The recipe identifies third-party runtimes inherited from the pinned releases. A separate build operator can compare all three resulting archive hashes with the public qualification record.

| Shipped bridge | SHA-256 |
| --- | --- |
| Linux amd64 | `8ce3360d1bc51056eb176ddfec68bd2824e9c6285cecd7a5e0dd2fdd4257f42a` |
| Windows amd64 | `bafd7d7ee04e2184b7dca18d7a5926391149a43dce3f2b884f7e7df535e8db8a` |
