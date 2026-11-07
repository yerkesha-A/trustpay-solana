import { createTestPool } from "./lib/defi-fixture";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  CpmmConfigInfoLayout,
  getCpmmPdaAmmConfigId,
} from "@raydium-io/raydium-sdk-v2";
import { assertDevnet, loadPool, RAYDIUM_DEVNET } from "../shared/defi";

async function main() {
  const c = new Connection("https://api.devnet.solana.com", {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
  });
  await assertDevnet(c);
  mkdirSync(".anchor", { recursive: true });
  const path = ".anchor/week09-wallet.json";
  const payer = existsSync(path)
    ? Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
      )
    : Keypair.generate();
  if (!existsSync(path))
    writeFileSync(path, JSON.stringify(Array.from(payer.secretKey)), {
      mode: 0o600,
    });
  const fixturePath = ".anchor/week09-fixture.json";
  if (existsSync(fixturePath)) {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    await loadPool(c, new PublicKey(fixture.pool));
    console.log("Existing real Devnet pool:", fixture.pool);
    return;
  }
  const configId = getCpmmPdaAmmConfigId(RAYDIUM_DEVNET, 0).publicKey;
  const info = await c.getAccountInfo(configId);
  if (
    !info?.owner.equals(RAYDIUM_DEVNET) ||
    info.data.length !== CpmmConfigInfoLayout.span
  )
    throw Error("Invalid Raydium config");
  const config = CpmmConfigInfoLayout.decode(info.data);
  if (config.disableCreatePool) throw Error("Raydium disabled pool creation");
  const required = BigInt(config.createPoolFee.toString()) + 100_000_000n;
  const balance = await c.getBalance(payer.publicKey);
  if (BigInt(balance) < required)
    throw Error(
      `Нужно минимум ${Number(required) / 1e9} бесплатных Devnet SOL. Баланс: ${balance / 1e9}. Адрес тестового кошелька: ${payer.publicKey.toBase58()}. Используйте https://faucet.solana.com, RPC faucet закрыт.`,
    );
  const fixture = await createTestPool(c, payer);
  const signature = fixture.createSignature;
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n");
  console.log("Confirmed real Raydium Devnet pool:", fixture.pool);
  console.log(
    "Creation: https://explorer.solana.com/tx/" + signature + "?cluster=devnet",
  );
  console.log("VITE_DEFI_POOL_ID=" + fixture.pool);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
