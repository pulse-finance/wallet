import { Buffer } from "buffer";
import { mnemonicToSeedSync } from "@scure/bip39";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import {
  DustAddress,
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  UnshieldedAddress,
  mainnet,
} from "@midnight-ntwrk/wallet-sdk-address-format";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import { createKeystore } from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { MidnightNetwork, WalletAddresses, WalletConfig } from "./types";

export type DerivedAddressField = {
  value: string | null;
  error: string | null;
};

export type DerivedWalletDisplay = {
  addresses: {
    unshielded: DerivedAddressField;
    shielded: DerivedAddressField;
    dust: DerivedAddressField;
  };
};

export function deriveWalletAddresses(phrase: string, network: MidnightNetwork): WalletAddresses {
  const derived = deriveDisplayAddresses(
    {
      id: "",
      name: "",
      phrase,
      network,
      addresses: {
        unshielded: "",
        shielded: "",
        dust: "",
      },
    },
    network,
  );
  const unshielded = derived.addresses.unshielded.value;
  const shielded = derived.addresses.shielded.value;
  const dust = derived.addresses.dust.value;

  if (!unshielded || !shielded || !dust) {
    throw new Error(
      derived.addresses.unshielded.error ??
        derived.addresses.shielded.error ??
        derived.addresses.dust.error ??
        "Failed to derive wallet addresses",
    );
  }

  return { unshielded, shielded, dust };
}

export function deriveDisplayAddresses(wallet: WalletConfig, network: MidnightNetwork): DerivedWalletDisplay {
  if (!globalThis.Buffer) {
    globalThis.Buffer = Buffer;
  }

  try {
    const seed = mnemonicToSeedSync(wallet.phrase);
    const hdWallet = HDWallet.fromSeed(seed);
    if (hdWallet.type !== "seedOk") {
      throw new Error("Failed to initialize HD wallet");
    }

    const derivationResult = hdWallet.hdWallet
      .selectAccount(0)
      .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust] as const)
      .deriveKeysAt(0);

    hdWallet.hdWallet.clear();

    if (derivationResult.type !== "keysDerived") {
      throw new Error("Failed to derive Midnight wallet keys");
    }

    const addresses: DerivedWalletDisplay["addresses"] = {
      unshielded: { value: null, error: null },
      shielded: { value: null, error: null },
      dust: { value: null, error: null },
    };

    const unshieldedKeystore = createKeystore(derivationResult.keys[Roles.NightExternal], network);
    const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derivationResult.keys[Roles.Zswap]);
    const dustSecretKey = ledger.DustSecretKey.fromSeed(derivationResult.keys[Roles.Dust]);
    const addressNetwork = network === "mainnet" ? mainnet : network;

    try {
      const unshieldedAddress = new UnshieldedAddress(Buffer.from(unshieldedKeystore.getAddress(), "hex"));
      addresses.unshielded.value = UnshieldedAddress.codec.encode(addressNetwork, unshieldedAddress).asString();
    } catch (caught) {
      addresses.unshielded.error = formatError(caught);
    }

    try {
      const shieldedAddress = new ShieldedAddress(
        ShieldedCoinPublicKey.fromHexString(shieldedSecretKeys.coinPublicKey),
        ShieldedEncryptionPublicKey.fromHexString(shieldedSecretKeys.encryptionPublicKey),
      );
      addresses.shielded.value = MidnightBech32m.encode(addressNetwork, shieldedAddress).asString();
    } catch (caught) {
      addresses.shielded.error = formatError(caught);
    }

    try {
      const dustAddress = new DustAddress(dustSecretKey.publicKey);
      addresses.dust.value = DustAddress.codec.encode(addressNetwork, dustAddress).asString();
    } catch (caught) {
      addresses.dust.error = formatError(caught);
    }

    shieldedSecretKeys.clear();
    dustSecretKey.clear();

    return { addresses };
  } catch (caught) {
    return {
      addresses: {
        unshielded: { value: null, error: formatError(caught) },
        shielded: { value: null, error: formatError(caught) },
        dust: { value: null, error: formatError(caught) },
      },
    };
  }
}

function formatError(caught: unknown) {
  return caught instanceof Error ? caught.message : String(caught);
}
