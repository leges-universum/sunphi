# SunPhi · sun(φ)

Project website, working protocol documentation, and conditional research calculators.

Website: https://coin.sun-phi.com/

Documentation: https://coin.sun-phi.com/#/docs

This repository is not a production cryptocurrency, wallet, or distributed consensus implementation. No tokens are issued by this code. Network acceptance rules, issuance parameters, and client releases remain under development.

## Structure

```
src/SunPhi.jsx                # Project website and hash navigation
src/Documentation.jsx        # Documentation pages and calculators
src/docs-content.js          # Canonical English documentation
src/research-math.mjs         # Conditional probability calculations
src/research-math.test.mjs    # Mathematical boundary and reference tests
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
| `npm test` | Check probability formulas against exhaustive small cases and boundary inputs |

## Base44 CLI

```bash
base44 login
base44 site deploy --no-build
```

Build before deploying. A Base44 app connection is required; credentials and local app identifiers are not included. This website does not require backend entities or functions.

## Research boundaries

The availability calculator assumes independent holders of distinct, current, valid fragments. It does not compute the probability of an illicit payment or establish protocol security. Economic inputs are illustrative sensitivity assumptions.

The working whitepaper is generated from `src/docs-content.js`, keeping website and download content aligned. Update that source, then build.

## Security and contributions

Do not submit wallet keys, credentials, private data, or unreviewed exploit details in public issues. A private vulnerability-reporting route, contribution process, release-signing policy, and project license have not yet been established. Dependencies retain their own licenses.

Only the dedicated SunPhi website and research files belong in this publication. The existing business-platform repository is separate.
