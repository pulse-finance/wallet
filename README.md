# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Linux Packages

This project builds `.deb` and `.AppImage` packages with GitHub Actions.

The Debian package is built with Tauri v2 and depends on the system `libwebkit2gtk-4.1-0` package. Use the AppImage when you want a more self-contained Linux artifact that can run without installing the `.deb` package.

### Download from a release

Tagged builds publish the Linux packages as GitHub Release assets.

1. Open the repository's **Releases** page on GitHub.
2. Choose the latest release.
3. Download either `pulse-finance-wallet_*.deb` or `pulse-finance-wallet_*.AppImage`.

To run the AppImage:

```sh
chmod a+x pulse-finance-wallet_*.AppImage
./pulse-finance-wallet_*.AppImage
```

To install the Debian package:

```sh
sudo apt install ./pulse-finance-wallet_*.deb
```

### Download from a workflow run

Every push, pull request, and manual workflow run uploads the Linux packages as workflow artifacts.

1. Open the repository's **Actions** page on GitHub.
2. Select the **Build Linux Packages** workflow.
3. Open a completed run.
4. Download the `pulse-finance-wallet-appimage` or `pulse-finance-wallet-deb` artifact.
5. Unzip the artifact and run or install the package.

For AppImage:

```sh
unzip pulse-finance-wallet-appimage.zip
chmod a+x pulse-finance-wallet_*.AppImage
./pulse-finance-wallet_*.AppImage
```

For Debian:

```sh
unzip pulse-finance-wallet-deb.zip
sudo apt install ./pulse-finance-wallet_*.deb
```

## Local DApp Wallet API

Pulse Wallet exposes a local REST API for dapps and other local clients that cannot use an injected `window.midnight` browser wallet API.

The public API is served by the Tauri/Rust backend at:

```text
http://127.0.0.1:6301
```

All Midnight endpoints are namespaced under `/midnight`. Future chains should use their own top-level namespace, such as `/cardano` or `/bitcoin`.

### Architecture

- Rust owns the public HTTP server, CORS/preflight handling, dapp approval prompts, and persisted client approvals.
- A separate Node.js sidecar owns the active Midnight `WalletFacade` and performs wallet SDK operations.
- The existing wallet sync sidecar remains focused on sync status/cache only.
- Rust launches the dapp connector sidecar on a randomly selected internal loopback port `>= 16000` and forwards approved requests to it with a per-process bearer token.

### Client Identity and Approvals

Browser clients are identified by their `Origin` header. Non-browser clients can send `X-Pulse-Client-Name`; otherwise they are identified as `local-client`.

The first request from a new identity opens a Pulse Wallet approval modal. Approved identities are persisted in the app cache. `POST /midnight/balance` also asks for approval every time because it creates a wallet-balanced transaction. `POST /midnight/submit` does not ask for per-transaction approval after the client identity is approved, because transaction submission is not wallet-authoritative.

### Endpoints

#### `GET /midnight/configuration`

Returns wallet network/service configuration in the same shape dapps commonly expect from `WalletConnectedAPI.getConfiguration()`.

```json
{
  "indexerUri": "https://indexer.preprod.midnight.network/api/v4/graphql",
  "indexerWsUri": "wss://indexer.preprod.midnight.network/api/v4/graphql/ws",
  "substrateNodeUri": "https://rpc.preprod.midnight.network",
  "proverServerUri": "http://127.0.0.1:6300",
  "networkId": "preprod"
}
```

#### `GET /midnight/addresses`

Returns the active wallet's Midnight addresses and public keys.

```json
{
  "shieldedAddress": "mn_shield-addr...",
  "shieldedCoinPublicKey": "mn_shield-cpk...",
  "shieldedEncryptionPublicKey": "mn_shield-epk...",
  "unshieldedAddress": "mn_addr...",
  "dustAddress": "mn_dust-addr..."
}
```

#### `GET /midnight/balance`

Returns active wallet balances. Bigints are serialized as decimal strings.

```json
{
  "shieldedBalances": {
    "token-type-hex": "1000000"
  },
  "unshieldedBalances": {
    "token-type-hex": "5000000"
  },
  "dustBalance": {
    "balance": "1230000000000000",
    "cap": "2000000000000000"
  }
}
```

#### `POST /midnight/balance`

Balances a transaction with the active wallet and returns a finalized serialized transaction.

```json
{
  "tx": "hex-serialized-transaction",
  "kind": "auto",
  "options": {
    "payFees": true,
    "tokenKindsToBalance": "all"
  }
}
```

`kind` can be `auto`, `unsealed`, or `sealed`. The public naming maps to the current `WalletFacade` naming as follows:

- `unsealed` means an unbound transaction and uses `balanceUnboundTransaction`.
- `sealed` means a bound/finalized transaction and uses `balanceFinalizedTransaction`.
- `auto` tries unbound first, then bound.

`tokenKindsToBalance` can be `"all"` or an array containing `dust`, `shielded`, and/or `unshielded`.

Response:

```json
{
  "tx": "hex-serialized-balanced-finalized-transaction"
}
```

#### `POST /midnight/submit`

Submits a finalized transaction through the active wallet facade.

```json
{
  "tx": "hex-serialized-finalized-transaction"
}
```

Response:

```json
{
  "ok": true,
  "txId": "transaction-identifier",
  "txHash": "transaction-hash"
}
```

### Error Responses

Errors are JSON responses with an `error` string.

- `400` for invalid JSON or invalid request shape.
- `403` for denied or timed-out approval.
- `404` for unknown routes.
- `409` when no active wallet is available.
- `503` when the internal dapp connector sidecar is unavailable.
