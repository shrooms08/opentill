/**
 * Regtest "customer wallet": pay an invoice address from the smoke state's
 * customer key (receive chain index 1 of .tachi-smoke-state.json), exactly as
 * scripts/tachi-e2e.ts does. Prints the tx hash.
 *
 *   npm run pay:tachi -- <bcrt1p-address> <sats>
 */
import { readFileSync } from "node:fs";
import { TachiClient } from "@tachibtc/tachi-sdk-ts";
import { getAccountNonce, waitForTachiTxCommit } from "@tachibtc/taurus-vault-core";
import { buildSignedTransferHex, MerchantKeyring } from "@opentill/adapter";

const RPC = process.env.TACHI_RPC_URL ?? "https://rpc-regtest.tachibtc.com";
const [to, satsArg] = process.argv.slice(2);
if (!to || !satsArg) throw new Error("usage: tachi-pay <address> <sats>");
const amount = BigInt(satsArg);
const smoke = JSON.parse(readFileSync(".tachi-smoke-state.json", "utf8")) as { mnemonic: string };
const client = new TachiClient({ baseUrl: RPC });
const kr = await MerchantKeyring.fromMnemonic(smoke.mnemonic, "regtest");
const customer = kr.derive(1, false);
const fee = 1n;
const vtxos = (await client.getAddressVtxos(customer.address, false)).vtxos.filter((v) => !v.spent && !v.locked);
const inSum = vtxos.reduce((a, v) => a + BigInt(v.amount), 0n);
if (inSum < amount + fee) throw new Error(`customer ${customer.address} has ${inSum} sats, needs ${amount + fee}`);
const nonce = await getAccountNonce(Buffer.from(customer.xOnlyHex, "hex"), { baseUrl: RPC });
const hex = await buildSignedTransferHex({
  signer: kr.signer(customer), spenderXOnly: Buffer.from(customer.xOnlyHex, "hex"),
  inputs: vtxos.map((v) => ({ vtxoId: v.id, valueSats: BigInt(v.amount) })),
  outputs: [{ owner: kr.ownerFromAddress(to), amountSats: amount }, ...(inSum - amount - fee > 0n ? [{ owner: Buffer.from(customer.xOnlyHex, "hex"), amountSats: inSum - amount - fee }] : [])],
  feeSats: fee, nonce,
});
const bc = await client.broadcastTxSync(hex);
const r = (bc as any).result;
console.log(`pay ${amount} sats → ${to}  code=${r.code} log=${JSON.stringify(r.log)} hash=${String(r.hash).toLowerCase()}`);
if (r.code !== 0) process.exit(1);
const st = await waitForTachiTxCommit(String(r.hash).toLowerCase(), { baseUrl: RPC });
console.log(`committed=${st.committed}  customer balance now: ${(await client.getBalance(customer.address)).balance_sat} sats`);
