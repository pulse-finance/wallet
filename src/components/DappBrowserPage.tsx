import { WalletConfig } from "../types";

const DAPP_SUGGESTIONS = [
  "https://docs.midnight.network/",
  "https://midnight.network/",
  "https://github.com/midnightntwrk",
];

type DappBrowserPageProps = {
  connectedWallet: WalletConfig | null;
  urlInput: string;
  loadedUrl: string | null;
  browserKey: number;
  canGoBack: boolean;
  canGoForward: boolean;
  onUrlInput: (url: string) => void;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
};

export function DappBrowserPage({
  connectedWallet,
  urlInput,
  loadedUrl,
  browserKey,
  canGoBack,
  canGoForward,
  onUrlInput,
  onNavigate,
  onBack,
  onForward,
  onRefresh,
}: DappBrowserPageProps) {
  return (
    <section className="browser-page">
      <form
        className="browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          onNavigate(urlInput);
        }}
      >
        <button type="button" onClick={onBack} disabled={!canGoBack} aria-label="Back">
          ‹
        </button>
        <button type="button" onClick={onForward} disabled={!canGoForward} aria-label="Forward">
          ›
        </button>
        <button type="button" onClick={onRefresh} disabled={!loadedUrl} aria-label="Refresh">
          ↻
        </button>
        <input
          value={urlInput}
          onChange={(event) => onUrlInput(event.currentTarget.value)}
          placeholder="https://"
          aria-label="DApp URL"
        />
        <button type="submit">Go</button>
        <div className="connected-wallet">
          <span className={connectedWallet ? "connector-dot connected" : "connector-dot"} />
          {connectedWallet?.name ?? "No wallet connected"}
        </div>
      </form>

      <div className="browser-surface">
        {loadedUrl ? (
          <iframe
            key={browserKey}
            src={loadedUrl}
            title="DApp browser"
            sandbox="allow-forms allow-scripts allow-same-origin allow-popups"
          />
        ) : (
          <div className="suggestions">
            <h1>DApps</h1>
            <p>Select a DApp or enter a URL to open it in the embedded browser.</p>
            <div className="suggestion-list">
              {DAPP_SUGGESTIONS.map((url) => (
                <button key={url} type="button" onClick={() => onNavigate(url)}>
                  {url}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
