import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import "./App.css";

type MidnightNetwork = "preprod" | "mainnet";

type AppConfig = {
  network: MidnightNetwork;
};

type ProofServerStatus = {
  url: string;
  online: boolean;
  pid: number | null;
  restarts: number;
  lastError: string | null;
};

const NETWORK_LABELS: Record<MidnightNetwork, string> = {
  preprod: "Midnight Preprod",
  mainnet: "Midnight Mainnet",
};

const HEALTHCHECK_INTERVAL_MS = 2_000;

function App() {
  const [network, setNetwork] = useState<MidnightNetwork>("preprod");
  const [status, setStatus] = useState<ProofServerStatus | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runningInTauri = useMemo(() => isTauri(), []);

  const refreshStatus = useCallback(async () => {
    if (!runningInTauri) {
      setError("Run this screen with pnpm tauri dev to manage the bundled proof server.");
      return;
    }

    try {
      const nextStatus = await invoke<ProofServerStatus>("get_proof_server_status");
      setStatus(nextStatus);
      setLastCheckedAt(new Date());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [runningInTauri]);

  useEffect(() => {
    if (!runningInTauri) {
      setError("Run this screen with pnpm tauri dev to manage the bundled proof server.");
      return;
    }

    let cancelled = false;

    async function loadConfig() {
      try {
        const config = await invoke<AppConfig>("get_app_config");
        if (!cancelled) {
          setNetwork(config.network);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    }

    loadConfig();
    refreshStatus();
    const interval = window.setInterval(refreshStatus, HEALTHCHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [refreshStatus, runningInTauri]);

  async function handleNetworkChange(nextNetwork: MidnightNetwork) {
    setNetwork(nextNetwork);

    try {
      const config = await invoke<AppConfig>("set_network", { network: nextNetwork });
      setNetwork(config.network);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function handleRestart() {
    try {
      const nextStatus = await invoke<ProofServerStatus>("restart_proof_server");
      setStatus(nextStatus);
      setLastCheckedAt(new Date());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <main className="app-shell">
      <section className="status-panel" aria-labelledby="proof-server-heading">
        <div className="header-row">
          <div>
            <p className="eyebrow">Pulse Wallet</p>
            <h1 id="proof-server-heading">Midnight proof server</h1>
          </div>
          <span className={status?.online ? "status-pill online" : "status-pill offline"}>
            {status?.online ? "Online" : "Offline"}
          </span>
        </div>

        <div className="controls-row">
          <label htmlFor="network">Network</label>
          <select
            id="network"
            value={network}
            onChange={(event) => handleNetworkChange(event.currentTarget.value as MidnightNetwork)}
          >
            <option value="preprod">{NETWORK_LABELS.preprod}</option>
            <option value="mainnet">{NETWORK_LABELS.mainnet}</option>
          </select>
        </div>

        <dl className="health-grid">
          <div>
            <dt>Endpoint</dt>
            <dd>{status?.url ?? "http://localhost:6300"}</dd>
          </div>
          <div>
            <dt>Process</dt>
            <dd>{status?.pid ? `PID ${status.pid}` : "Not attached"}</dd>
          </div>
          <div>
            <dt>Restarts</dt>
            <dd>{status?.restarts ?? 0}</dd>
          </div>
          <div>
            <dt>Last checked</dt>
            <dd>{lastCheckedAt ? lastCheckedAt.toLocaleTimeString() : "Pending"}</dd>
          </div>
        </dl>

        {status?.lastError ? <p className="error-text">{status.lastError}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}

        <div className="actions-row">
          <button type="button" onClick={refreshStatus}>
            Refresh
          </button>
          <button type="button" onClick={handleRestart} disabled={!runningInTauri}>
            Restart proof server
          </button>
        </div>
      </section>
    </main>
  );
}

export default App;
