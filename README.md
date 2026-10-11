# SunPhi · sun(φ)

Project website, working protocol documentation, and conditional research calculators.

Website: https://coin.sun-phi.com/

Documentation: https://coin.sun-phi.com/#/docs

GitHub: https://github.com/leges-universum/sunphi

This repository is not a production cryptocurrency, wallet, or distributed consensus implementation. No tokens are issued by this code. Network acceptance rules, issuance parameters, and client releases remain under development.

## Structure

```
src/SunPhi.jsx                # Project website and hash navigation
src/Documentation.jsx        # Documentation pages and calculators
src/docs-content.js          # Canonical English documentation
src/research-math.mjs         # Conditional probability calculations
src/research-math.test.mjs    # Mathematical boundary and reference tests
research/model.mjs           # Sequential transaction reference model
research/model.test.mjs      # Seven model tests, not network-security tests
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

The selected sale fee is 2% included in payment: 98% seller, 1% platform, 1% wallet reward funding. It covers fund sales and platform resales. Rewards are paid in sun(φ), proportional to accepted wallet authorization time; multiple wallets per operator count separately and are intentionally encouraged. The proposed funding route acquires existing tokens using the fee allocation. USD and BTC calculator scenarios use assumed acquisition prices, not market data or guaranteed cash values. Settlement period and acquisition execution remain open. The calculator does not authenticate wallets, collect fees, exchange assets, or pay rewards.

The exchange documentation considers a first native sun(φ)/BTC market and onward conversion to other crypto or bank money. No exchange listing, provider partnership, custody service, bridge, or live market is available.

The transaction reference model uses a single in-memory arbiter and its clock. It has no network, signature, or erasure-code implementation. Its legacy emission arithmetic uses an assumed 2,048-byte record; the separate 4,096-byte documentation scenario is another assumption, not a measurement or format change.

The working whitepaper is generated from `src/docs-content.js`, keeping website and download content aligned. Update that source, then build.

## Security and contributions

Do not submit wallet keys, credentials, private data, or unreviewed exploit details in public issues. A private vulnerability-reporting route, contribution process, release-signing policy, and project license have not yet been established. Dependencies retain their own licenses.

Only the dedicated SunPhi website and research files belong in this publication. The existing business-platform repository is separate.

## Tooling status

The generated Base44/Vite dependency tree currently reports 12 npm audit advisories (1 low, 2 moderate, 9 high). This publication is not a dependency-security audit or production client release. Review and update the tooling before distributing a client or exposing a development server.
