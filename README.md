# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Debian/Ubuntu Package

This project builds a `.deb` package with GitHub Actions.

### Download from a release

Tagged builds publish the Debian package as a GitHub Release asset.

1. Open the repository's **Releases** page on GitHub.
2. Choose the latest release.
3. Download the `pulse-finance-wallet_*.deb` asset.
4. Install it:

```sh
sudo apt install ./pulse-finance-wallet_*.deb
```

### Download from a workflow run

Every push, pull request, and manual workflow run uploads the Debian package as a workflow artifact.

1. Open the repository's **Actions** page on GitHub.
2. Select the **Build Debian Package** workflow.
3. Open a completed run.
4. Download the `pulse-finance-wallet-deb` artifact.
5. Unzip the artifact and install the package:

```sh
unzip pulse-finance-wallet-deb.zip
sudo apt install ./pulse-finance-wallet_*.deb
```
