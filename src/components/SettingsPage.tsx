import { FormEvent, useEffect, useState } from "react";
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
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Network endpoints</h1>
        </div>
      </div>
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
