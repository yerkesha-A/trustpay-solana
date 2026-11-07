// Run only against a local validator. Private key stays outside the repository.
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      readFileSync(
        process.env.ANCHOR_WALLET || ".anchor/local-wallet.json",
        "utf8",
      ),
    ),
  ),
);
const owner = process.argv[2];
if (!owner)
  throw new Error(
    "Usage: node scripts/create-test-mint.mjs PHANTOM_PUBLIC_KEY",
  );
const mint = await createMint(connection, payer, payer.publicKey, null, 6);
const ata = await getOrCreateAssociatedTokenAccount(
  connection,
  payer,
  mint,
  new PublicKey(owner),
);
const signature = await mintTo(
  connection,
  payer,
  mint,
  ata.address,
  payer,
  1_000_000_000n,
);
console.log("Test mint:", mint.toBase58());
console.log("Confirmed local mint transaction:", signature);
