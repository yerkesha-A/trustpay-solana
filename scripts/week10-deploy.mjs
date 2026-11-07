// Existing project signer + program keypair only. Never print CLI recovery phrases.
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
const connection = new Connection("https://api.devnet.solana.com", {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
});
try {
  if (
    (await connection.getGenesisHash()) !==
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
  )
    throw Error("Wrong network");
  const signerPath = ".anchor/week09-wallet.json",
    programPath = "target/deploy/trustpay-keypair.json",
    binaryPath = "target/deploy/trustpay.so";
  const signer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(signerPath, "utf8"))),
  );
  const program = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(programPath, "utf8"))),
  ).publicKey;
  const idl = JSON.parse(readFileSync("app/src/idl.json", "utf8"));
  if (program.toBase58() !== idl.address)
    throw Error("Existing program keypair and IDL do not agree");
  const bytes = statSync(binaryPath).size;
  const minimum =
    (await connection.getMinimumBalanceForRentExemption(bytes + 45)) +
    (await connection.getMinimumBalanceForRentExemption(36)) +
    80_000_000;
  const balance = await connection.getBalance(signer.publicKey);
  if (balance < minimum)
    throw Error(
      `Insufficient test SOL: ${(balance / 1e9).toFixed(9)}. Need at least ${(minimum / 1e9).toFixed(9)} total. Existing signer: ${signer.publicKey.toBase58()}`,
    );
  const cli = process.env.TRUSTPAY_SOLANA_BIN || "solana";
  let log = "";
  try {
    log = execFileSync(
      cli,
      [
        "program",
        "deploy",
        binaryPath,
        "--program-id",
        programPath,
        "--upgrade-authority",
        signerPath,
        "--keypair",
        signerPath,
        "--url",
        "https://api.devnet.solana.com",
        "--max-len",
        String(bytes),
        "--use-rpc",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300000 },
    );
  } catch (e) {
    const raw = String(e.stdout || "") + "\n" + String(e.stderr || "");
    writeFileSync(".anchor/week10-deploy.log", raw, { mode: 0o600 });
    const line = raw.split("\n").find((line) => /^Error: /.test(line));
    throw Error(
      `Deployment failed (exit ${e.status ?? "timeout"}). ${line || "Diagnostic log retained only in ignored .anchor/week10-deploy.log."}`,
    );
  }
  // Whitelist public fields only; private CLI recovery output is never forwarded.
  for (const line of log.split("\n"))
    if (/^(Program Id:|Signature:)/.test(line)) console.log(line);
  const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const [programData] = PublicKey.findProgramAddressSync(
    [program.toBuffer()],
    loader,
  );
  const account = await connection.getAccountInfo(program),
    data = await connection.getAccountInfo(programData);
  if (!account?.executable || !account.owner.equals(loader) || !data)
    throw Error("Deployed account verification failed");
  const binary = readFileSync(binaryPath),
    deployed = data.data.subarray(45, 45 + binary.length);
  const hash = createHash("sha256").update(binary).digest("hex");
  if (createHash("sha256").update(deployed).digest("hex") !== hash)
    throw Error("Deployed bytecode hash differs from local build");
  const signature =
    log.match(/^Signature:\s*([1-9A-HJ-NP-Za-km-z]+)\s*$/m)?.[1] ?? null;
  writeFileSync(
    ".anchor/week10-deployment.json",
    JSON.stringify(
      {
        network: "devnet",
        program: program.toBase58(),
        programData: programData.toBase58(),
        binaryBytes: bytes,
        sha256: hash,
        signature,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "PASS: deployed executable bytecode matches local SHA-256; existing project/program keypairs preserved.",
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
