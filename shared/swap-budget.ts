import { ComputeBudgetProgram } from "@solana/web3.js";

// Explicit Devnet swap policy, set before approval. No wallet-selected extra fee.
// The live ATA + CPMM simulation consumed ~38k CU; this leaves ample headroom.
export const SWAP_COMPUTE_UNIT_LIMIT = 200_000;
export const SWAP_COMPUTE_UNIT_PRICE = 0n; // micro-lamports per CU
export function swapComputeBudgetInstructions() {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: SWAP_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: SWAP_COMPUTE_UNIT_PRICE }),
  ];
}

// Diagnostics only: decoding never grants permission for added instructions.
export function decodeComputeBudget(message: import("@solana/web3.js").Message) {
  const entries = message.compiledInstructions.flatMap((ix, index) => {
    if (!message.accountKeys[ix.programIdIndex].equals(ComputeBudgetProgram.programId)) return [];
    const bytes = ix.data;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[0] === 2 && bytes.length === 5)
      return [{ index, kind: "SetComputeUnitLimit", value: String(view.getUint32(1, true)) }];
    if (bytes[0] === 3 && bytes.length === 9)
      return [{ index, kind: "SetComputeUnitPrice", value: view.getBigUint64(1, true).toString() }];
    return [{ index, kind: "other or malformed", value: Array.from(bytes).join(",") }];
  });
  const limits = entries.filter(x => x.kind === "SetComputeUnitLimit");
  const prices = entries.filter(x => x.kind === "SetComputeUnitPrice");
  const priorityFeeLamports = entries.length === 2 && limits.length === 1 && prices.length === 1
    ? ((BigInt(limits[0].value) * BigInt(prices[0].value) + 999_999n) / 1_000_000n).toString()
    : null;
  return { entries, priorityFeeLamports };
}
