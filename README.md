# PayStream

PayStream is an Algorand-based payroll MVP for cross-border contractor payouts using USDCa. The app lets an employer deploy or attach to a PayStream vault, deposit USDCa, and execute payouts to contractor wallets with a simple operator dashboard.

This repository is a monorepo built with AlgoKit:
- Smart contract project in Python (`projects/contracts`)
- Frontend project in React + TypeScript (`projects/frontend`)

## Table of Contents
- [What This Repo Contains](#what-this-repo-contains)
- [Current MVP Scope](#current-mvp-scope)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Quick Start (TestNet - Recommended)](#quick-start-testnet---recommended)
- [LocalNet Setup (Optional)](#localnet-setup-optional)
- [Environment Variables](#environment-variables)
- [Runbook: Typical Payment Flow](#runbook-typical-payment-flow)
- [Smart Contract API](#smart-contract-api)
- [Development Commands](#development-commands)
- [Troubleshooting](#troubleshooting)
- [Security and Production Notes](#security-and-production-notes)
- [Contributing](#contributing)

## What This Repo Contains

```text
.
|-- projects/
|   |-- contracts/                 # Algorand smart contract project (Python)
|   |   |-- smart_contracts/pay_stream/contract.py
|   |   |-- smart_contracts/pay_stream/deploy_config.py
|   |   `-- smart_contracts/artifacts/pay_stream/
|   `-- frontend/                  # React app (operator + contractor UI)
|       |-- src/components/PayStreamDashboard.tsx
|       |-- src/contracts/PayStream.ts
|       `-- src/utils/network/getAlgoClientConfigs.ts
|-- .algokit.toml                  # Workspace-level AlgoKit config
`-- README.md
```

## Current MVP Scope

### On-chain capabilities
- Deploy PayStream app (vault) from the dashboard.
- Vault opt-in to a configured ASA (USDCa by default).
- Deposit ASA to vault using grouped tx (asset transfer + app call).
- Payout from vault to contractor addresses (admin-only action).
- Withdraw funds back to admin (contract method exists, not exposed in current UI).
- Track `admin` and `total_deposited` in global state.

### Off-chain (browser-local) MVP behavior
- Contractor directory and preferred currency selection.
- 30-second quote preview and FX conversion simulation.
- Scheduled payouts and due processing queue.
- Contractor cash-out modes (`hold`, `instant`, `standard`) as UI/workflow simulation.
- CSV/PDF activity export.
- State persistence in browser `localStorage` (network-scoped key).

## Architecture

### Frontend (`projects/frontend`)
- `src/components/PayStreamDashboard.tsx`
  - Main product UI for employer, contractor, and metrics tabs.
  - Wallet connection, deploy/attach, deposit, payout, schedules, cash-out, and export.
- `src/contracts/PayStream.ts`
  - Generated typed client from ARC-56 app spec.
- `src/utils/network/getAlgoClientConfigs.ts`
  - Reads Algod/Indexer/KMD configs from Vite env vars.

### Contract (`projects/contracts`)
- `smart_contracts/pay_stream/contract.py`
  - `opt_in_to_asset(asset)`
  - `deposit(txn)`
  - `payout(recipient, asset, amount)`
  - `withdraw_admin(asset, amount)`
- `smart_contracts/__main__.py`
  - Build/export contract artifacts and generate clients.
- `smart_contracts/pay_stream/deploy_config.py`
  - Deployment helper using AlgoKit utils.

## Prerequisites

Install these before running the project:
- Node.js `>=20.0`
- npm `>=9.0`
- pnpm (optional, needed for `algokit project run build` in this workspace)
- Python `>=3.12`
- [Poetry](https://python-poetry.org/docs/#installation)
- [AlgoKit CLI `>=2.0.0`](https://github.com/algorandfoundation/algokit-cli#install)
- [Docker](https://www.docker.com/) (needed for LocalNet)
- Pera Wallet browser extension (recommended for current dashboard flow)

## Quick Start (TestNet - Recommended)

1. Clone and enter repo

```bash
git clone https://github.com/ShreyashDabhade/PayStream.git
cd PayStream
```

2. Bootstrap workspace dependencies

```bash
algokit project bootstrap all
```

3. Configure frontend env file (`projects/frontend/.env`)

Use this TestNet baseline:

```bash
VITE_ENVIRONMENT=local
VITE_ALGOD_TOKEN=
VITE_ALGOD_SERVER=https://testnet-api.algonode.cloud
VITE_ALGOD_PORT=
VITE_ALGOD_NETWORK=testnet

VITE_INDEXER_TOKEN=
VITE_INDEXER_SERVER=https://testnet-idx.algonode.cloud
VITE_INDEXER_PORT=

VITE_USDCA_ASSET_ID=10458941
```

4. Start frontend

```bash
cd projects/frontend
npm run dev
```

5. Open app in browser and connect wallet.

6. In `Employer` tab:
- Set asset ID (USDCa)
- Click `Deploy` to create a new vault, or set existing App ID and click `Attach`
- Deposit USDCa
- Add contractors and execute payouts

## LocalNet Setup (Optional)

1. Start LocalNet

```bash
algokit localnet start
```

2. Configure `projects/frontend/.env` using local values from `projects/frontend/.env.template`.

3. Set local asset id (if using AlgoKit default LocalNet assets):

```bash
VITE_USDCA_ASSET_ID=1023
```

4. Start frontend

```bash
cd projects/frontend
npm run dev
```

Known limitation:
- Current dashboard connect flow explicitly prefers Pera wallet in `projects/frontend/src/components/PayStreamDashboard.tsx`.
- LocalNet KMD config exists in the app bootstrap layer, but the current connect button flow is optimized for TestNet/Pera.

## Environment Variables

Frontend config is read in `projects/frontend/src/utils/network/getAlgoClientConfigs.ts`.

| Variable | Required | Description |
| --- | --- | --- |
| `VITE_ALGOD_SERVER` | Yes | Algod endpoint URL |
| `VITE_ALGOD_PORT` | Yes (can be empty string) | Algod port |
| `VITE_ALGOD_TOKEN` | Yes (can be empty string) | Algod API token |
| `VITE_ALGOD_NETWORK` | Yes | `localnet`, `testnet`, or `mainnet` |
| `VITE_INDEXER_SERVER` | Yes | Indexer endpoint URL |
| `VITE_INDEXER_PORT` | Yes (can be empty string) | Indexer port |
| `VITE_INDEXER_TOKEN` | Yes (can be empty string) | Indexer token |
| `VITE_USDCA_ASSET_ID` | Strongly recommended | ASA used for vault accounting and payouts |
| `VITE_KMD_SERVER` | LocalNet only | KMD endpoint |
| `VITE_KMD_PORT` | LocalNet only | KMD port |
| `VITE_KMD_TOKEN` | LocalNet only | KMD token |
| `VITE_KMD_WALLET` | LocalNet only | KMD wallet name |
| `VITE_KMD_PASSWORD` | LocalNet only | KMD wallet password |

Notes:
- `VITE_ALGOD_NODE_CONFIG_SERVER|PORT|TOKEN` are supported fallback names for Algod config.
- Restart `npm run dev` after changing env vars.

## Runbook: Typical Payment Flow

1. Connect employer wallet.
2. Deploy vault (or attach existing App ID).
3. Deposit USDCa into vault.
4. Add contractor and set preferred currency.
5. Ensure contractor wallet is opted-in to configured asset.
6. Generate quote (30s window) and execute payout.
7. Optionally create schedules and process due items.
8. Contractor tab can simulate cash-out modes and export history.

## Smart Contract API

Contract source: `projects/contracts/smart_contracts/pay_stream/contract.py`

| Method | Purpose | Access Control |
| --- | --- | --- |
| `opt_in_to_asset(asset)` | Opts vault into an asset so it can hold ASA balance | Admin only |
| `deposit(txn)` | Validates deposit transfer to app address and updates total | Caller supplies grouped transfer |
| `payout(recipient, asset, amount)` | Sends payout from vault to contractor via inner tx | Admin only |
| `withdraw_admin(asset, amount)` | Withdraws from vault to admin wallet | Admin only |

## Development Commands

### Workspace (root)

```bash
algokit project bootstrap all
algokit project run build
```

### Frontend (`projects/frontend`)

```bash
npm run dev
npm run build
npm run lint
npm run test
npm run playwright:test
npm run generate:app-clients
```

### Contracts (`projects/contracts`)

```bash
algokit project run build
algokit project run lint
algokit project run test
algokit project deploy localnet
algokit project deploy testnet
```

If contract ABI changes, regenerate/link frontend clients:

```bash
cd projects/contracts
algokit project run build
cd ../frontend
npm run generate:app-clients
```

## Troubleshooting

### `Attempt to get default algod configuration...`
- Cause: missing `VITE_ALGOD_SERVER` (or fallback env vars).
- Fix: update `projects/frontend/.env` and restart dev server.

### Pera shows a stuck pending request
- Use `Reset Wallet Session` button in UI.
- Reconnect wallet and retry transaction.

### `Contractor wallet must opt-in to asset ...`
- Contractor must opt-in to the configured ASA before payout.
- Ensure connected wallet matches contractor address when running opt-in action.

### Deposit fails with grouped transaction confusion
- Deposit intentionally creates a grouped operation (asset transfer + app call).
- In Pera this appears as one "Multiple Transaction Request".

### No transactions shown in On-chain App Calls
- Verify Indexer env values.
- Ensure App ID is valid and network matches your deployed app.

### PDF export does nothing
- Browser likely blocked pop-ups.
- Allow pop-ups for localhost and retry.

## Security and Production Notes

- This is an MVP and has not been audited.
- `withdraw_admin` allows admin withdrawal by design.
- Quote, FX conversion, scheduling, and cash-out flows are currently client-side logic.
- Browser `localStorage` is not secure storage for sensitive business records.
- For production, add:
  - secure backend for quote and settlement orchestration,
  - custody and role controls (for example multisig/admin policies),
  - monitoring/alerting and compliance workflows,
  - independent smart contract and application security review.

## Contributing

1. Create a feature branch.
2. Keep changes scoped and documented.
3. Run lint/build before opening a PR.
4. Include screenshots or reproduction steps for UI or flow changes.
