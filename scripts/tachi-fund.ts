/**
 * Regtest-only float tool: mint a self-signed ledger DEPOSIT to one of the
 * merchant's keys (the regtest daemon accepts these at fee >= 1 sat — the
 * sequence proven in docs/tachi-smoke-output.md §7A). Do not assume this works
 * on signet/mainnet (open question #2 in INTEGRATION.md).
 *
 *   TACHI_MNEMONIC="…" npm run fund:tachi -- [--sats 50000] [--change] [--index 0]
 */
import { TachiClient } from "@tachibtc/tachi-sdk-ts";
import { buildTachiTxDeposit, encodeTachiTx, getAccountNonce, signTachiTx, waitForTachiTxCommit } from "@tachibtc/taurus-vault-core";
import { MerchantKeyring } from "@opentill/adapter";

const RPC = process.env.TACHI_RPC_URL ?? "https://rpc-regtest.tachibtc.com";
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1]! : d; };
const sats = BigInt(arg("--sats", "50000"));
const index = Number(arg("--index", "0"));
const change = process.argv.includes("--change");
const mnemonic = process.env.TACHI_MNEMONIC;
if (!mnemonic) throw new Error("TACHI_MNEMONIC is required");

const client = new TachiClient({ baseUrl: RPC });
const kr = await MerchantKeyring.fromMnemonic(mnemonic, "regtest");
const key = kr.derive(index, change);
const xOnly = Buffer.from(key.xOnlyHex, "hex");
const nonce = await getAccountNonce(xOnly, { baseUrl: RPC });
const draft = buildTachiTxDeposit({ userXOnly: xOnly, amountSats: sats, nonce, feeSats: 1n });
const hex = encodeTachiTx(await signTachiTx(draft, kr.signer(key))).toString("hex");
const bc = await client.broadcastTxSync(hex);
const r = (bc as any).result;
console.log(`deposit ${sats} sats → ${key.address} (${key.path})  code=${r.code} log=${JSON.stringify(r.log)} hash=${r.hash}`);
if (r.code !== 0) process.exit(1);
const st = await waitForTachiTxCommit(String(r.hash).toLowerCase(), { baseUrl: RPC });
console.log(`committed=${st.committed} height=${(st as any).height ?? "?"}  balance now: ${(await client.getBalance(key.address)).balance_sat} sats`);
