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
