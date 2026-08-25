/**
 * Live smoke against the Tachi regtest daemon — Step 1 of the real-adapter gate.
 *
 * Prints every real response verbatim and writes docs/tachi-smoke-output.md,
 * which is the ground truth the adapter is written against. Nothing here is
 * adapter code. Run: `npm run smoke:tachi` (needs network; regtest coins only).
 *
 * Key material (a BIP-39 mnemonic) is read from TACHI_SMOKE_MNEMONIC or
 * generated once and persisted to .tachi-smoke-state.json (gitignored) so the
 * funded keys can be reused by the e2e run.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { BIP32Factory, type BIP32Interface } from "bip32";
import * as bip39 from "bip39";
import { TachiClient } from "@tachibtc/tachi-sdk-ts";
import {
  buildTachiTxDeposit,
  deriveUserKey,
  encodeTachiTx,
  getAccountNonce,
  normalizeTaprootSigner,
  resolveWalletNetwork,
  signTachiTx,
  waitForTachiTxCommit,
  xOnlyFromAddress,
  TACHI_TX_TYPE_TRANSFER,
  TACHI_TX_VERSION,
  type TachiTx,
} from "@tachibtc/taurus-vault-core";

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

const RPC = process.env.TACHI_RPC_URL ?? "https://rpc-regtest.tachibtc.com";
const FAUCET = process.env.TACHI_FAUCET_URL ?? "https://faucet.tachibtc.com";
const STATE_FILE = ".tachi-smoke-state.json";
const OUT_FILE = "docs/tachi-smoke-output.md";
const WATCH_MS = 30_000;

const client = new TachiClient({ baseUrl: RPC });
const net = bitcoin.networks.regtest;

// ---- recording -------------------------------------------------------------
const sections: string[] = [];
const j = (x: unknown) =>
  JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `${v}n` : Buffer.isBuffer(v) ? v.toString("hex") : v), 2);
function record(title: string, body: string) {
  console.log(`\n## ${title}\n${body}`);
  sections.push(`## ${title}\n\n${body}`);
}
function rec(title: string, value: unknown, note?: string) {
  record(title, `${note ? note + "\n\n" : ""}\`\`\`json\n${j(value)}\n\`\`\``);
}
function recErr(title: string, err: unknown) {
  record(title, `**ERROR** (verbatim):\n\n\`\`\`\n${err instanceof Error ? err.message : String(err)}\n\`\`\``);
}

// ---- keys ------------------------------------------------------------------
interface KeySet { index: number; path: string; xOnly: Buffer; address: string; node: BIP32Interface; descriptor: unknown }
function keyAt(root: BIP32Interface, mnemonic: string, index: number): KeySet {
  const descriptor = deriveUserKey(mnemonic, resolveWalletNetwork("regtest"), { index });
  const node = root.derivePath(descriptor.path);
  const xOnly = Buffer.from(node.publicKey).subarray(1, 33);
  const address = bitcoin.payments.p2tr({ pubkey: xOnly, network: net }).address!;
  if (!xOnlyFromAddress(address, net).equals(xOnly)) throw new Error("address/x-only round-trip mismatch");
  return { index, path: descriptor.path, xOnly, address, node, descriptor };
}

// ---- watch (WebSocket async iterator) ---------------------------------------
function startWatch(label: string, address: string, ms: number) {
  const ac = new AbortController();
  const events: unknown[] = [];
  const done = (async () => {
    try {
      for await (const ev of client.watch({ address }, { signal: ac.signal })) {
        events.push(ev);
        console.log(`[watch:${label}]`, JSON.stringify(ev));
      }
    } catch (e) {
      if (!ac.signal.aborted) events.push({ watchError: e instanceof Error ? e.message : String(e) });
    }
  })();
  const timer = setTimeout(() => ac.abort(), ms);
  return { events, stop: async () => { clearTimeout(timer); ac.abort(); await done; } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- main ------------------------------------------------------------------
async function main() {
  const startedAt = new Date().toISOString();
  record("Run", `- when: ${startedAt}\n- rpc: \`${RPC}\`\n- faucet: \`${FAUCET}\`\n- sdk: @tachibtc/tachi-sdk-ts 0.2.1, @tachibtc/taurus-vault-core 0.3.3\n- node: ${process.version}`);

  // 1. connectivity
  rec("1. getHealth()", await client.getHealth());
  const status = await client.getStatus();
  rec("1. getStatus()", status);
  const height = Number((status as any)?.result?.sync_info?.latest_block_height);
  record("1. connectivity summary", `network=\`${(status as any)?.result?.node_info?.network}\` height=${height} catching_up=${(status as any)?.result?.sync_info?.catching_up}`);

  // 2. key management
  let mnemonic = process.env.TACHI_SMOKE_MNEMONIC;
  let persisted: any = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : null;
  if (!mnemonic && persisted?.mnemonic) mnemonic = persisted.mnemonic;
  const generated = !mnemonic;
  if (!mnemonic) mnemonic = bip39.generateMnemonic(128);
  const root = bip32.fromSeed(await bip39.mnemonicToSeed(mnemonic), net);
  const k0 = keyAt(root, mnemonic, 0); // merchant / invoice key
  const k1 = keyAt(root, mnemonic, 1); // second key (receiver for the transfer experiment)
  writeFileSync(STATE_FILE, JSON.stringify({ mnemonic, rpc: RPC, keys: [k0, k1].map((k) => ({ index: k.index, path: k.path, xOnly: k.xOnly.toString("hex"), address: k.address })) }, null, 2));
  record(
    "2. key management (documented path)",
    [
      `Mnemonic ${generated ? "GENERATED" : "reused"} (persisted to \`${STATE_FILE}\`, gitignored).`,
      "Per-key: `deriveUserKey(mnemonic, resolveWalletNetwork(\"regtest\"), { index })` (vault-core → wallet-aggregator, BIP-84 path `m/84'/1'/0'/0/<index>`) gives the public descriptor; the private key is derived with bip32 along `descriptor.path`; the ledger owner is the 32-byte x-only key; the receive address is that x-only key encoded as a bech32m P2TR output key (`bitcoinjs payments.p2tr({ pubkey })`), which `xOnlyFromAddress` decodes back — round-trip asserted.",
      "",
      "```json",
      j({ key0: { path: k0.path, xOnly: k0.xOnly, address: k0.address, descriptor: k0.descriptor }, key1: { path: k1.path, xOnly: k1.xOnly, address: k1.address } }),
      "```",
    ].join("\n"),
  );

  // 3. empty address shapes
  try { rec("3. getAddressVtxos(addr) — empty", await client.getAddressVtxos(k0.address)); } catch (e) { recErr("3. getAddressVtxos", e); }
  try { rec("3. getAddressVtxos(addr, includeSpent=true) — empty", await client.getAddressVtxos(k0.address, true)); } catch (e) { recErr("3. getAddressVtxos(includeSpent)", e); }
  try { rec("3. getBalance(addr) — before", await client.getBalance(k0.address)); } catch (e) { recErr("3. getBalance", e); }
  try { rec("3. getAddress(addr) — before", await client.getAddress(k0.address)); } catch (e) { recErr("3. getAddress", e); }

  // 4. watch
  const w0 = startWatch("key0", k0.address, WATCH_MS + 90_000);
  await sleep(1500);
  record("4. watch({ address })", `Opened \`client.watch({ address: "${k0.address}" })\` (WebSocket async iterator). Events collected for the rest of the run are listed in section 9.`);

  // 5. faucet
  let faucetTxid: string | null = persisted?.faucetTxid ?? null;
  try {
    if (faucetTxid) record("5. faucet", `Reusing faucet txid from state: \`${faucetTxid}\` (no new claim).`);
    const cap = await (await fetch(`${FAUCET}/api/capacity?address=${encodeURIComponent(k0.address)}`)).json();
    rec("5. faucet GET /api/capacity", cap);
    if (!faucetTxid) {
    const res = await fetch(`${FAUCET}/api/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: k0.address, amountBtc: 0.001, proof: null }) });
    const body = await res.json().catch(async () => ({ nonJson: await res.text() }));
    rec(`5. faucet POST /api/faucet → HTTP ${res.status}`, body, "Request body: `{ address, amountBtc: 0.001, proof: null }` (the faucet UI's exact call; address must be a regtest bcrt1…/m…/n…/2… address, ≤0.5 BTC per claim, 24h cap per address).");
    faucetTxid = (body as any)?.txid ?? null;
    }
    if (faucetTxid) writeFileSync(STATE_FILE, JSON.stringify({ ...JSON.parse(readFileSync(STATE_FILE, "utf8")), faucetTxid }, null, 2));
  } catch (e) { recErr("5. faucet", e); }

  // what did the faucet produce? L1 utxo and/or ledger vtxo
  await sleep(12_000);
  if (faucetTxid) {
    try { const r = await client.bitcoinRPC({ method: "getrawtransaction", params: [faucetTxid, true] }); rec("5. bitcoinRPC getrawtransaction(faucetTxid, verbose) — L1 view", r); } catch (e) { recErr("5. getrawtransaction", e); }
  }
  try { const r = await client.bitcoinRPC({ method: "scantxoutset", params: ["start", [`addr(${k0.address})`]] }); rec("5. bitcoinRPC scantxoutset addr(k0) — L1 UTXOs at our taproot address", r); } catch (e) { recErr("5. scantxoutset", e); }
  try { rec("5. getAddressVtxos(addr) — after faucet (ledger view)", await client.getAddressVtxos(k0.address, true)); } catch (e) { recErr("5. getAddressVtxos after faucet", e); }
  try { rec("5. getMempoolByAddress(addr) — after faucet", await client.getMempoolByAddress(k0.address)); } catch (e) { recErr("5. getMempoolByAddress", e); }

  // 6. balance after
  try { rec("6. getBalance(addr) — after faucet", await client.getBalance(k0.address)); } catch (e) { recErr("6. getBalance", e); }

  // 7. EXPERIMENT A — self-signed ledger deposit (what the observed block-480722 `deposit` looks like)
  let depositVtxo: { id: string; amount: number } | null = null;
  try {
    const nonce = await getAccountNonce(k0.xOnly, { baseUrl: RPC });
    const feeEst = await client.getFeeEstimate();
    rec("7A. getFeeEstimate()", feeEst);
    const depositFee = BigInt(Math.max(1, feeEst.min_fee_sat));
    const draft = buildTachiTxDeposit({ userXOnly: k0.xOnly, amountSats: 50_000n, nonce, feeSats: depositFee });
    const signed = await signTachiTx(draft, normalizeTaprootSigner(k0.node));
    const hex = encodeTachiTx(signed).toString("hex");
    rec("7A. buildTachiTxDeposit → signTachiTx → encodeTachiTx", { nonce, amountSats: "50000n", feeSats: depositFee, hexBytes: hex.length / 2, hexPrefix: hex.slice(0, 64) + "…" });
    try { rec("7A. decodeTransaction(hex) — daemon decode before broadcast", await client.decodeTransaction(hex)); } catch (e) { recErr("7A. decodeTransaction", e); }
    const bc = await client.broadcastTxSync(hex);
    rec("7A. broadcastTxSync(depositHex) — RAW (HTTP 200 is not success; read result.code/log)", bc);
    const code = (bc as any)?.result?.code;
    if (code === 0) {
      const hash = (bc as any).result.hash as string;
      const st = await waitForTachiTxCommit(hash, { baseUrl: RPC, timeoutMs: 60_000 } as any);
      rec("7A. waitForTachiTxCommit(hash)", st);
      const after = await client.getAddressVtxos(k0.address, true);
      rec("7A. getAddressVtxos(addr, includeSpent) — after deposit", after);
      const v = after.vtxos.find((x) => !x.spent);
      if (v) depositVtxo = { id: v.id, amount: v.amount };
      rec("7A. getBalance / getAddress after deposit", { balance: await client.getBalance(k0.address), address: await client.getAddress(k0.address) });
    } else {
      record("7A. verdict", `Daemon REJECTED the self-signed deposit: code=${code} log=\`${(bc as any)?.result?.log}\`. A ledger deposit therefore needs L1 backing (vault path) on this daemon.`);
    }
  } catch (e) { recErr("7A. self-signed ledger deposit", e); }

  // 8. EXPERIMENT B — key→key ledger TRANSFER (this is OpenTill's payment + refund path)
  if (depositVtxo) {
    const w1 = startWatch("key1", k1.address, 90_000);
    await sleep(1000);
    try {
      const fee = 1n;
      const send = 10_000n;
      const change = BigInt(depositVtxo.amount) - send - fee;
      const nonce = await getAccountNonce(k0.xOnly, { baseUrl: RPC });
      const tx: TachiTx = {
        version: TACHI_TX_VERSION, type: TACHI_TX_TYPE_TRANSFER,
        inputs: [{ vtxoId: Buffer.from(depositVtxo.id, "hex"), txid: Buffer.alloc(32, 0), vout: 0, valueSats: BigInt(depositVtxo.amount), sigScript: Buffer.alloc(0) }],
        outputs: [
          { owner: k1.xOnly, amount: send, script: Buffer.alloc(0) },
          { owner: k0.xOnly, amount: change, script: Buffer.alloc(0) },
        ],
        fee, nonce, pubKey: k0.xOnly, signature: Buffer.alloc(0), psbtPayload: Buffer.alloc(0), vaultPayload: Buffer.alloc(0),
      };
      const signed = await signTachiTx(tx, normalizeTaprootSigner(k0.node));
      const hex = encodeTachiTx(signed).toString("hex");
      rec("8B. hand-built TRANSFER (no vault, empty PSBT) → sign → encode", { input: depositVtxo, outputs: { toKey1: `${send}n`, changeToKey0: `${change}n` }, fee: "1n", nonce, hexBytes: hex.length / 2 });
      try { rec("8B. decodeTransaction(hex)", await client.decodeTransaction(hex)); } catch (e) { recErr("8B. decodeTransaction", e); }
      const bc = await client.broadcastTxSync(hex);
      rec("8B. broadcastTxSync(transferHex) — RAW (check result.code/log)", bc);
      const code = (bc as any)?.result?.code;
      if (code === 0) {
        const hash = (bc as any).result.hash as string;
        const st = await waitForTachiTxCommit(hash, { baseUrl: RPC, timeoutMs: 60_000 } as any);
        rec("8B. waitForTachiTxCommit(hash)", st);
        try { rec("8B. getTransaction(hash)", await client.getTransaction(hash)); } catch (e) { recErr("8B. getTransaction", e); }
        rec("8B. receiver key1 — getAddressVtxos / getBalance / getAddress", { vtxos: await client.getAddressVtxos(k1.address, true), balance: await client.getBalance(k1.address), address: await client.getAddress(k1.address) });
        rec("8B. sender key0 — getAddressVtxos(includeSpent) / getBalance / getAddress", { vtxos: await client.getAddressVtxos(k0.address, true), balance: await client.getBalance(k0.address), address: await client.getAddress(k0.address) });
      } else {
        record("8B. verdict", `Daemon REJECTED the plain transfer: code=${code} log=\`${(bc as any)?.result?.log}\`.`);
      }
    } catch (e) { recErr("8B. transfer", e); }
    await sleep(4000);
    await w1.stop();
    rec("9. watch events — key1 (receiver) — verbatim", w1.events);
  } else {
    record("8B. transfer", "Skipped — no spendable ledger VTXO on key0 (see 7A).");
  }

  await sleep(3000);
  await w0.stop();
  rec("9. watch events — key0 — verbatim", w0.events);

  writeFileSync(OUT_FILE, `# Tachi regtest smoke — real response record\n\nGenerated by \`npm run smoke:tachi\` (scripts/tachi-smoke.ts). Every block is the daemon's verbatim response. This file is the ground truth the real adapter is written against.\n\n${sections.join("\n\n")}\n`);
  console.log(`\nwrote ${OUT_FILE}`);
}

main().catch((e) => { console.error("SMOKE FAILED:", e); recErr("FATAL", e); writeFileSync(OUT_FILE, `# Tachi regtest smoke — FAILED\n\n${sections.join("\n\n")}\n`); process.exit(1); });
