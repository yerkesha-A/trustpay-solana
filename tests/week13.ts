import { expect } from "chai";
import BN from "bn.js";
import { Keypair, PublicKey, Transaction, SystemProgram, Connection } from "@solana/web3.js";
import { WEEK13 } from "../shared/week13-config";
import { assertPaymentAction, validatePaymentParties, stablecoinMint, type Payment } from "../shared/payments";
import { quotePositionAdd, quotePositionAddTicks, quotePositionIncrease, quotePositionRemove, validatePositionQuote, validateTicks, type Position } from "../shared/positions";
import type { ClmmMarket } from "../shared/market";
import { requestWalletSignature } from "../shared/wallet-signing";
const client = Keypair.generate(), worker = Keypair.generate(), other = Keypair.generate();
const account = (status: string) => ({ client: client.publicKey, freelancer: worker.publicKey, mint: new PublicKey(WEEK13.stableMint), status: { [status]: {} }, id: new BN(1), amount: new BN(1000000), title: 'Test' }) as Payment['account'];
const market = () => ({ address: new PublicKey(WEEK13.pool), decimalsA: 6, decimalsB: 6, state: { sqrtPriceX64: new BN(2).pow(new BN(64)), tickSpacing: 60, liquidity: new BN(0) } }) as ClmmMarket;
const position = (m: ClmmMarket, liquidity = 1000000n) => ({ nftMint: Keypair.generate().publicKey, owner: client.publicKey, state: { poolId: m.address, tickLower: -1200, tickUpper: 1200, liquidity: new BN(liquidity.toString()) } }) as Position;
describe('Week13 payments', () => {
    it('enforces both escrow roles for submit/cancel/release/refund', () => {
        assertPaymentAction(account('funded'), worker.publicKey, 'submitWork');
        assertPaymentAction(account('funded'), worker.publicKey, 'allowCancel');
        assertPaymentAction(account('submitted'), client.publicKey, 'release');
        assertPaymentAction(account('cancelApproved'), client.publicKey, 'refund');
        for (const [status, action] of [['funded', 'submitWork'], ['funded', 'allowCancel'], ['submitted', 'release'], ['cancelApproved', 'refund']] as const)
            expect(() => assertPaymentAction(account(status), other.publicKey, action)).to.throw('полномочий');
    });
    it('blocks repeated release/refund and refund before consent', () => {
        expect(() => assertPaymentAction(account('paid'), client.publicKey, 'release')).to.throw('статусе');
        expect(() => assertPaymentAction(account('refunded'), client.publicKey, 'refund')).to.throw('статусе');
        expect(() => assertPaymentAction(account('funded'), client.publicKey, 'refund')).to.throw('статусе');
    });
    it('rejects a different payment mint and self/empty worker identities', () => {
        expect(() => assertPaymentAction({ ...account('submitted'), mint: Keypair.generate().publicKey }, client.publicKey, 'release')).to.throw('mint');
        expect(() => validatePaymentParties(client.publicKey, client.publicKey)).to.throw();
        expect(() => validatePaymentParties(client.publicKey, PublicKey.default)).to.throw();
    });
    it('rejects Mainnet before loading the stablecoin mint', async () => {
        const c = { rpcEndpoint: 'https://api.devnet.solana.com', getGenesisHash: async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' } as unknown as Connection;
        let error;
        try {
            await stablecoinMint(c);
        }
        catch (e) {
            error = e;
        }
        expect(String(error)).include('другой сети');
    });
});
describe('Week13 CLMM quotes', () => {
    it('aligns the range and keeps slippage maxima within the selected budgets', () => {
        const q = quotePositionAdd(market(), client.publicKey, '0.9', '1.1', 10000000n, 10000000n, 50);
        expect(q.tickLower % 60).eq(0);
        expect(q.tickUpper % 60).eq(0);
        expect(q.liquidity > 0n && q.limitA <= 10000000n && q.limitB <= 10000000n).eq(true);
        expect(q.limitA >= q.amountA && q.limitB >= q.amountB).eq(true);
    });
    it('uses only the appropriate token outside the range', () => {
        const q = quotePositionAdd(market(), client.publicKey, '1.1', '1.2', 10000000n, 0n, 50);
        expect(q.amountA > 0n).eq(true);
        expect(q.amountB).eq(0n);
    });
    it('rejects malformed ranges, unaligned ticks, invalid budgets and slippage', () => {
        for (const [lo, hi] of [['2', '1'], ['NaN', '2'], ['0', '1']])
            expect(() => quotePositionAdd(market(), client.publicKey, lo, hi, 100n, 100n, 50)).to.throw();
        for (const args of [[0, 0, 60], [1, 60, 60], [-500000, 60, 60], [0, 60, 0]])
            expect(() => validateTicks(...args as [
                number,
                number,
                number
            ])).to.throw();
        for (const bps of [0, 501, NaN, 1.1])
            expect(() => quotePositionAddTicks(market(), client.publicKey, -1200, 1200, 10000n, 10000n, bps)).to.throw();
        for (const budget of [-1n, 1n << 64n])
            expect(() => quotePositionAddTicks(market(), client.publicKey, -1200, 1200, budget, 0n, 50)).to.throw();
    });
    it('increases using the exact existing ticks instead of a price round trip', () => {
        const m = market(), p = position(m);
        const q = quotePositionIncrease(m, p, 1000000n, 1000000n, 50);
        expect(q.tickLower).eq(p.state.tickLower);
        expect(q.tickUpper).eq(p.state.tickUpper);
        expect(q.position?.equals(p.nftMint)).eq(true);
    });
    it('guards removal size, pool and conservatively rounded minimum outputs', () => {
        const m = market(), p = position(m);
        const q = quotePositionRemove(m, p, 1000000n, 50);
        expect(q.limitA <= q.amountA && q.limitB <= q.amountB).eq(true);
        expect(() => quotePositionRemove(m, p, 1000001n, 50)).to.throw();
        expect(() => quotePositionRemove({ ...m, address: other.publicKey }, p, 1n, 50)).to.throw('другого пула');
        const collect = quotePositionRemove(m, p, 0n, 50);
        expect(collect.limitA + collect.limitB).eq(0n);
    });
    it('rejects owner changes, stale/future quotes and modified limits', () => {
        const q = quotePositionAdd(market(), client.publicKey, '0.9', '1.1', 1000000n, 1000000n, 50);
        validatePositionQuote(q, client.publicKey);
        expect(() => validatePositionQuote(q, other.publicKey)).to.throw('кошелька');
        expect(() => validatePositionQuote(q, client.publicKey, q.createdAt + 30001)).to.throw('истёк');
        expect(() => validatePositionQuote(q, client.publicKey, q.createdAt - 1)).to.throw('истёк');
        expect(() => validatePositionQuote({ ...q, limitA: q.limitA + 1n }, client.publicKey)).to.throw('изменён');
    });
    it('preserves the ephemeral NFT signature while requesting the wallet signature', async () => {
        const nft = Keypair.generate(), blockhash = Keypair.generate().publicKey.toBase58();
        const tx = new Transaction({ feePayer: client.publicKey, recentBlockhash: blockhash }).add(SystemProgram.createAccount({ fromPubkey: client.publicKey, newAccountPubkey: nft.publicKey, lamports: 1, space: 0, programId: SystemProgram.programId }));
        tx.partialSign(nft);
        const result = await requestWalletSignature({ publicKey: client.publicKey, signTransaction: async (t) => { t.partialSign(client); return t; } }, tx, blockhash);
        expect(result.verifySignatures()).eq(true);
        expect(result.signatures.length).eq(2);
    });
});
