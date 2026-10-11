# SunPhi · sun(φ)

Project website, working protocol documentation, and conditional research calculators.

Website: https://coin.sun-phi.com/

Documentation: https://coin.sun-phi.com/#/docs

GitHub: https://github.com/leges-universum/sunphi

This repository is not a production cryptocurrency, wallet, or distributed consensus implementation. No tokens are issued by this code. The selected cap is 100 million, issued on completed purchases; network admission, custody, legal terms and client releases remain under development.

A local **SunPhi Wallet 0.1 laboratory CLI** is now available in [wallet/README.md](wallet/README.md).
It creates encrypted local keys, verifies backups and signs both transfer circuits.
Run `node wallet/cli.mjs demo` for a no-value, in-memory transfer demonstration.
This does not connect to a live network or change the website into a signing wallet.

## Structure

```
src/SunPhi.jsx                # Project website and hash navigation
src/Documentation.jsx        # Documentation pages and calculators
src/docs-content.js          # Canonical English documentation
src/protocol-docs.js         # Token, two-circuit workflow, privacy and recovery
src/issuance-docs.js         # Supply, reserve transparency and launch boundaries
src/issuance-policy.mjs      # Cap, primary quote and research basket
src/reserve-reader.mjs       # Manual public balance observations; no signing
src/ReservePanels.jsx        # Issuance and reserve research panels
research/issuance-model.mjs  # Serial purchase ledger; trusted laboratory receipts
research/issuance-model.test.mjs # Cap, replay, funding and valuation tests
research/reserve-reader.test.mjs # Provider failures and chain consistency
src/ProtocolVisuals.jsx      # Interactive diagrams and conversion preview
src/NavigationControls.jsx  # Accessible drawer and page scrolling
src/research-math.mjs         # Conditional probability calculations
src/research-math.test.mjs    # Mathematical boundary and reference tests
research/model.mjs           # Sequential transaction reference model
research/model.test.mjs      # Seven model tests, not network-security tests
wallet/                     # Offline encrypted wallet, CLI, signed lab protocol and tests
scripts/build-docs.mjs       # Generates the downloadable working whitepaper
public/                      # Public project note, favicon, generated whitepaper
base44/config.jsonc           # Static hosting configuration
```

## Development

```bash
npm install
npm test
npm run dev
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build |
| `npm test` | Check the transaction reference model, probability formulas, and fee/reward arithmetic |

## Base44 CLI

```bash
base44 login
base44 site deploy --no-build
```

Build before deploying. A Base44 app connection is required; credentials and local app identifiers are not included. This website does not require backend entities or functions.

## Research boundaries

The availability calculator assumes independent holders of distinct, current, valid fragments. It does not compute the probability of an illicit payment or establish protocol security. Economic inputs are illustrative sensitivity assumptions.

Primary purchases initially cost $1.02: $1 reserve principal, $0.01 platform and $0.01 reward funding. Secondary resales retain the inclusive 98% seller / 1% platform / 1% rewards split. Reserve principal is not platform revenue. Rewards are paid in sun(φ), proportional to accepted wallet authorization time; multiple wallets per operator count separately and are intentionally encouraged. The proposed funding route acquires existing tokens using the fee allocation. USD and BTC calculator scenarios use assumed acquisition prices, not market data or guaranteed cash values. Settlement period and acquisition execution remain open. The calculator does not authenticate wallets, collect fees, exchange assets, or pay rewards.

The exchange documentation considers a first native sun(φ)/BTC market and onward conversion to other crypto or bank money. No exchange listing, provider partnership, custody service, bridge, or live market is available.

The transaction reference model uses a single in-memory arbiter and its clock. It has no network, signature, or erasure-code implementation. Its legacy emission arithmetic uses an assumed 2,048-byte record; the separate 4,096-byte documentation scenario is another assumption, not a measurement or format change.

The working whitepaper is generated from `src/docs-content.js` and its imported protocol and issuance documents, keeping all 20 chapters aligned with the website. The diagrams illustrate proposed behavior, not live network execution. The conversion preview uses a user-supplied price assumption and the selected inclusive fee, not a market quote. Update canonical content, then build.

The purchase ledger is a serial, in-memory reference: trusted test payment and acquisition receipts precede a simulated mint, with idempotency and a cumulative cap. It does not verify real settlement or implement durable multi-process issuance. No reserve addresses or live supply are configured. The 90% USDC / 10% BTC basket is a research scenario pending legal and custody review, not an approved stablecoin reserve or dollar guarantee. Public balance observations alone cannot prove ownership, absence of liens or solvency.

## Security and contributions

Do not submit wallet keys, credentials, private data, or unreviewed exploit details in public issues. A private vulnerability-reporting route, contribution process, release-signing policy, and project license have not yet been established. Dependencies retain their own licenses.

Only the dedicated SunPhi website and research files belong in this publication. The existing business-platform repository is separate.

## Tooling status

The generated Base44/Vite dependency tree currently reports 12 npm audit advisories (1 low, 2 moderate, 9 high). This publication is not a dependency-security audit or production client release. Review and update the tooling before distributing a client or exposing a development server.
