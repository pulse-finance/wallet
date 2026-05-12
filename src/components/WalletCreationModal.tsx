import { FormEvent } from "react";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

type WalletCreationModalProps = {
  walletCount: number;
  walletName: string;
  walletPhrase: string;
  onNameChange: (name: string) => void;
  onPhraseChange: (phrase: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
};

export function WalletCreationModal({
  walletCount,
  walletName,
  walletPhrase,
  onNameChange,
  onPhraseChange,
  onSubmit,
  onClose,
}: WalletCreationModalProps) {
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal" onSubmit={onSubmit}>
        <div className="modal-header">
          <h2>Add wallet</h2>
          <button type="button" className="icon-button" onClick={onClose}>
            x
          </button>
        </div>
        <label htmlFor="wallet-name">Name</label>
        <input
          id="wallet-name"
          value={walletName}
          onChange={(event) => onNameChange(event.currentTarget.value)}
          placeholder={`Wallet ${walletCount + 1}`}
        />
        <label htmlFor="wallet-phrase">Phrase</label>
        <textarea
          id="wallet-phrase"
          value={walletPhrase}
          onChange={(event) => onPhraseChange(event.currentTarget.value)}
          rows={6}
          spellCheck={false}
        />
        <div className="modal-actions">
          <button type="button" onClick={() => onPhraseChange(generateMnemonic(wordlist, 256))}>
            Generate phrase
          </button>
          <button type="submit">Add wallet</button>
        </div>
      </form>
    </div>
  );
}
