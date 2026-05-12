import { MidnightNetwork } from "../types";

const NETWORK_LABELS: Record<MidnightNetwork, string> = {
  preprod: "Preprod",
  mainnet: "Mainnet",
};

type BottomBarProps = {
  network: MidnightNetwork;
  onNetworkChange: (network: MidnightNetwork) => void;
};

export function BottomBar({ network, onNetworkChange }: BottomBarProps) {
  return (
    <footer className="bottom-bar">
      <select
        className="bottom-bar-network-select"
        aria-label="Network"
        value={network}
        onChange={(event) => onNetworkChange(event.currentTarget.value as MidnightNetwork)}
      >
        <option value="preprod">{NETWORK_LABELS.preprod}</option>
        <option value="mainnet">{NETWORK_LABELS.mainnet}</option>
      </select>
    </footer>
  );
}
