# DueByte protocol and verification

The release catalog selects the software a node installs. Its target metadata identifies the archive and the digest of the file manifest. Each release archive contains the corresponding protocol modules. For a reproducible review, identify the catalog commit, target, version, manifest digest, network pin and block height. GitHub's automatically generated source archives describe the tag tree. Use the named Home and Server release assets for inspection of shipped software.

| Artifact | Purpose |
| --- | --- |
| [Stable channel](https://github.com/leges-universum/sunphi/tree/duebyte-updates-stable) | Signed update metadata and edition-specific targets |
| [Server 0.3.145](https://github.com/leges-universum/sunphi/releases/tag/duebyte-v0.3.145) and [Home 0.3.146](https://github.com/leges-universum/sunphi/releases/tag/duebyte-v0.3.146) | Reference installations for this review |
| [Pinned Server target](https://github.com/leges-universum/sunphi/blob/c16426909c49e980ff7ac71fc8ce8037eb873e02/targets/storage-v1-server-linux-x64.json) | Server archive selection, network pin and manifest digest |
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

The V4 planning export illustrates a starting balance of 2,000 DUBYT. The published ordinary schedule presents the full node allocation of 9,880,000,000 DUBYT. These inputs explain why adding the rows of the historical example produces a different total. The January 2027 programme transition has its own state and rules. The historical export's empty start date describes the preparation object. The Human–AI Research Fund proposal concerns the purpose of the existing restricted allocation. Execution of research awards requires separate authority and software support.

### Repeat the comparison

Download the named `DueByte-Server-0.3.145-Linux-x64.tar.gz` release asset and verify its SHA-256 before extracting into an empty directory. The reference archive digest is `e0e5b14e35060bf949b1e2b9ef098a509daed3e89db63e3932b0d630fc198eeb`. Save the two economic files linked above alongside it. With Node.js 24 run

```sh
node verify-economics.mjs DueByte-Server-0.3.145-Linux-x64 economic-policy-v4.json ordinary-node-calendar.csv
```

The verifier checks the pinned manifest and every listed file before loading the release planner. It compares the allocations, ten decade totals, 100 planning years and all 100 annual budgets and cumulative totals in the ordinary schedule using integer arithmetic. This comparison establishes agreement for these artifacts. Exhaustive transition reachability and independent reconstruction of the release binaries require additional evidence.

## Trust and operational evidence

### Signed application messages

Encode the schema-validated message as UTF-8. Objects use lexicographically sorted UTF-16 key sequences, with JSON string escaping for keys and values. Arrays retain element order. Object and array delimiters have no surrounding whitespace. Preserve Unicode sequences exactly. Integer JSON numbers are restricted to the JavaScript safe-integer range and use decimal notation, with zero encoded as `0`. Monetary strings retain their schema-defined decimal representation. Hash the encoded bytes with SHA-256 for application identifiers. Application Ed25519 signatures cover the encoded message bytes. CometBFT votes have their own signing format. Run `node verify-canonical.mjs SERVER_DIR` for executable application examples, including Unicode ordering and numeric boundaries.

| Authority | What the evidence establishes | Evidence still needed for economic operation |
| --- | --- | --- |
| Validators | Ed25519 precommits and voting power identify the signers of a block. A dated observation verified 264 signatures across 24 blocks, heights 129652–129675. | Identify independent beneficial control, hosting and recovery custody. Exercise quorum loss and recovery across those operators. |
| Checkpoint and client bootstrap | A pinned network and authenticated checkpoint give clients a starting state. | Demonstrate independent checkpoint verification and recovery from a separately administered archive. |
| Software releases | Signed catalog metadata authenticates selected packages under the client's update roots. | Separate signing custody, demonstrate loss and rotation of a release key, independently rebuild artifacts, and verify platform publisher signatures. |
| Fund and award administration | Protocol rules restrict balances, signatures and payment limits. | Document conflicts of interest, independent review of work coefficients, withdrawal controls and a funded procedure for claims. A protection reserve pays only under its rules and up to available funds. |

For Windows reviewers, `Test-WindowsPublishers.ps1` checks every executable, including compatibility copies, against Windows trust and a publisher thumbprint allowlist supplied independently for each binary name. A missing executable or unapproved signature fails the check. For Home 0.3.146 the launcher and consensus executables still require publisher signatures. The controlled pilot and scheduled network programme are distinct from acceptance of customer money, lending authority or insurance coverage.
