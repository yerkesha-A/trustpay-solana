import { Connection, Keypair, Transaction } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  DEVNET_PROGRAM_ID,
  getCpmmPdaAmmConfigId,
  getCreatePoolKeys,
  makeCreateCpmmPoolInInstruction,
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { assertDevnet, loadPool, RAYDIUM_DEVNET } from "../../shared/defi";
import { sendAndConfirmTransaction } from "@solana/web3.js";
export async function createTestPool(
  c: Connection,
  payer: Keypair,
  localFixture = false,
) {
  if (localFixture) {
    if (!["localhost", "127.0.0.1"].includes(new URL(c.rpcEndpoint).hostname))
      throw Error("Local fixture requires localhost");
  } else await assertDevnet(c);
  const program = await c.getAccountInfo(RAYDIUM_DEVNET);
  if (!program?.executable)
    throw Error("Official Raydium deployment not found");
  const configId = getCpmmPdaAmmConfigId(RAYDIUM_DEVNET, 0).publicKey;
  const signatures: string[] = [];
  // Create two SPL mints for the test pool.
  const mints = [
    await createMint(c, payer, payer.publicKey, null, 6),
    await createMint(c, payer, payer.publicKey, null, 6),
  ].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
  for (const mint of mints) {
    const ata = await getOrCreateAssociatedTokenAccount(
      c,
      payer,
      mint,
      payer.publicKey,
    );
    signatures.push(
      await mintTo(c, payer, mint, ata.address, payer, 10_000_000_000n),
    );
  }
  const [mintA, mintB] = mints;
  const keys = getCreatePoolKeys({
    programId: RAYDIUM_DEVNET,
    configId,
    mintA,
    mintB,
  });
  const tx = new Transaction().add(
    makeCreateCpmmPoolInInstruction(
      RAYDIUM_DEVNET,
      payer.publicKey,
      configId,
      keys.authority,
      keys.poolId,
      mintA,
      mintB,
      keys.lpMint,
      getAssociatedTokenAddressSync(mintA, payer.publicKey),
      getAssociatedTokenAddressSync(mintB, payer.publicKey),
      getAssociatedTokenAddressSync(keys.lpMint, payer.publicKey),
      keys.vaultA,
      keys.vaultB,
      DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC,
      TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      keys.observationId,
      new BN(1_000_000_000),
      new BN(1_000_000_000),
      new BN(0),
    ),
  );
  const signature = await sendAndConfirmTransaction(c, tx, [payer], {
    commitment: "confirmed",
  });
  const pool = await loadPool(c, keys.poolId, localFixture);
  return {
    network: localFixture ? "localnet-cloned-devnet" : "devnet",
    program: RAYDIUM_DEVNET.toBase58(),
    pool: pool.address.toBase58(),
    mintA: mintA.toBase58(),
    mintB: mintB.toBase58(),
    lpMint: keys.lpMint.toBase58(),
    createSignature: signature,
    mintSignatures: signatures,
  };
}
