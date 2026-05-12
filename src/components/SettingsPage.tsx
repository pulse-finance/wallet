import { FormEvent, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronLeft, ChevronRight, Settings as SettingsIcon, Trash2 } from "lucide-react";
import { NetworkEndpoints } from "../types";

const DAPP_PAGE_SIZE = 8;

type SettingsPageProps = {
  endpoints: NetworkEndpoints;
  onSave: (endpoints: NetworkEndpoints) => void;
};

export function SettingsPage({ endpoints, onSave }: SettingsPageProps) {
  const [draft, setDraft] = useState(endpoints);
  const [whitelistedDapps, setWhitelistedDapps] = useState<string[]>([]);
  const [whitelistedDappsPage, setWhitelistedDappsPage] = useState(1);
  const [whitelistedDappsError, setWhitelistedDappsError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(endpoints);
  }, [endpoints]);

  useEffect(() => {
    loadWhitelistedDapps();
  }, []);

  const whitelistedDappsPageCount = Math.max(1, Math.ceil(whitelistedDapps.length / DAPP_PAGE_SIZE));
  const visibleWhitelistedDapps = whitelistedDapps.slice(
    (whitelistedDappsPage - 1) * DAPP_PAGE_SIZE,
    whitelistedDappsPage * DAPP_PAGE_SIZE,
  );

  function update<K extends keyof NetworkEndpoints>(key: K, value: NetworkEndpoints[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(draft);
  }

  async function loadWhitelistedDapps() {
    try {
      const approvals = await invoke<string[]>("get_whitelisted_dapps");
      setWhitelistedDapps(approvals);
      setWhitelistedDappsPage((page) => Math.min(page, Math.max(1, Math.ceil(approvals.length / DAPP_PAGE_SIZE))));
      setWhitelistedDappsError(null);
    } catch (caught) {
      setWhitelistedDappsError(formatError(caught));
    }
  }

  async function deleteWhitelistedDapp(identity: string) {
    try {
      const approvals = await invoke<string[]>("delete_whitelisted_dapp", { identity });
      setWhitelistedDapps(approvals);
      setWhitelistedDappsPage((page) => Math.min(page, Math.max(1, Math.ceil(approvals.length / DAPP_PAGE_SIZE))));
      setWhitelistedDappsError(null);
    } catch (caught) {
      setWhitelistedDappsError(formatError(caught));
    }
  }

  return (
    <section className="page settings-page">
      <div className="page-header">
        <div className="page-title-with-icon">
          <SettingsIcon size={24} aria-hidden="true" />
          <h1>Settings</h1>
        </div>
      </div>
      <div className="settings-card">
        <h2>Midnight</h2>
        <form className="settings-form" onSubmit={submit}>
          <EndpointField
            label="Indexer URL"
            value={draft.indexerUrl}
            onChange={(value) => update("indexerUrl", value)}
          />
          <EndpointField
            label="Indexer WebSocket URL"
            value={draft.indexerWsUrl}
            onChange={(value) => update("indexerWsUrl", value)}
          />
          <EndpointField label="Node URL" value={draft.nodeUrl} onChange={(value) => update("nodeUrl", value)} />
          <EndpointField
            label="Node WebSocket URL"
            value={draft.nodeWsUrl}
            onChange={(value) => update("nodeWsUrl", value)}
          />
          <div className="settings-actions">
            <button type="submit">Save endpoints</button>
          </div>
        </form>
      </div>
      <div className="settings-card">
        <div className="section-header">
          <h2>Whitelisted DApps</h2>
          <PaginationControls
            page={whitelistedDappsPage}
            pageCount={whitelistedDappsPageCount}
            onPageChange={setWhitelistedDappsPage}
          />
        </div>
        {whitelistedDappsError ? <p className="sync-error">{whitelistedDappsError}</p> : null}
        {whitelistedDapps.length === 0 ? (
          <p className="muted">No whitelisted DApps</p>
        ) : (
          <div className="whitelisted-dapp-table">
            <div className="whitelisted-dapp-row whitelisted-dapp-head">
              <span>DApp</span>
              <span>Actions</span>
            </div>
            {visibleWhitelistedDapps.map((identity) => (
              <div key={identity} className="whitelisted-dapp-row">
                <code title={identity}>{identity}</code>
                <button
                  type="button"
                  className="icon-button danger-icon-button"
                  aria-label={`Delete ${identity}`}
                  title="Delete"
                  onClick={() => deleteWhitelistedDapp(identity)}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function EndpointField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  );
}

function PaginationControls({
  page,
  pageCount,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="pagination-controls">
      <button type="button" className="icon-button" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
        <ChevronLeft size={16} aria-hidden="true" />
      </button>
      <span>{page} / {pageCount}</span>
      <button type="button" className="icon-button" onClick={() => onPageChange(page + 1)} disabled={page >= pageCount}>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

function formatError(caught: unknown) {
  return caught instanceof Error ? caught.message : String(caught);
}
