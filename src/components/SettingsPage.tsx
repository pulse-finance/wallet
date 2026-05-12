import { FormEvent, useEffect, useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { NetworkEndpoints } from "../types";

type SettingsPageProps = {
  endpoints: NetworkEndpoints;
  onSave: (endpoints: NetworkEndpoints) => void;
};

export function SettingsPage({ endpoints, onSave }: SettingsPageProps) {
  const [draft, setDraft] = useState(endpoints);

  useEffect(() => {
    setDraft(endpoints);
  }, [endpoints]);

  function update<K extends keyof NetworkEndpoints>(key: K, value: NetworkEndpoints[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(draft);
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
