import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const PROTOCOL_VERSION = "2026-07-28";
const DEX = "https://api.dexscreener.com/latest/dex";
const COVALENT = "https://api.covalenthq.com/v1";
const RPCS: Record<string, string> = {
  base: process.env.BASE_RPC ?? "https://mainnet.base.org",
  ethereum: process.env.ETH_RPC ?? "https://cloudflare-eth.com",
};
const COV_CHAINS: Record<string, string> = {
  base: "base-mainnet",
  ethereum: "eth-mainnet",
  bsc: "bsc-mainnet",
  arbitrum: "arbitrum-mainnet",
  polygon: "matic-mainnet",
};

async function getJsonAuth(url: string, apiKey: string, timeoutMs = 8000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: "Basic " + Buffer.from(apiKey.trim()).toString("base64"),
      },
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} on ${new URL(url).hostname}`);
    return r.json();
  } finally {
    clearTimeout(t);
  }
}

async function getJson(url: string, timeoutMs = 8000, retries = 3): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: ctl.signal });
    if (r.status === 429 && retries > 0) {
      await new Promise((res) => setTimeout(res, 1500 * (4 - retries)));
      return getJson(url, timeoutMs, retries - 1);
    }
    if (!r.ok) throw new Error(`HTTP ${r.status} on ${new URL(url).hostname}`);
    return r.json();
  } finally {
    clearTimeout(t);
  }
}

async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`RPC ${r.status}`);
    const d: any = await r.json();
    if (d.error) throw new Error(`RPC: ${d.error.message ?? "unknown"}`);
    return d.result;
  } finally {
    clearTimeout(t);
  }
}
const nowIso = () => new Date().toISOString();
const isEvmAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
const DISCLAIMER = "Heuristic screen from public data, not financial advice.";

/* ---------------- Copycat Hunter ---------------- */
interface Candidate {
  address: string; name: string; symbol: string; chain: string; dex: string;
  liquidity_usd: number; volume_24h_usd: number; txns_24h: number;
  oldest_pair_at: number | null; pair_count: number; pair_url: string | null;
  rank: number; score: number;
}
function scoreCand(c: Candidate): number {
  const liq = Math.log10(c.liquidity_usd + 1) * 2;
  const age = c.oldest_pair_at ? Math.max(0, (Date.now() - c.oldest_pair_at) / 86_400_000 / 30) : 0;
  return liq + Math.min(age, 12) + Math.log10(c.txns_24h + 1);
}
async function copycatHunter(input: { address?: string; query?: string }) {
  const address = (input.address ?? "").trim() || null;
  const query = (input.query ?? "").trim() || null;
  if (!address && !query) throw new Error("Provide 'address' or 'query'.");
  let symbol: string | null = null, name: string | null = null;
  if (address) {
    if (!isEvmAddr(address) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))
      throw new Error("Invalid address.");
    const t = await getJson(`${DEX}/tokens/${address}`);
    const pairs = t.pairs ?? [];
    if (!pairs.length)
      return { query: { address, name, symbol }, verdict: "UNCERTAIN",
        verdict_reason: "No DexScreener pairs for this address.", candidates: [],
        evidence: [], disclaimer: DISCLAIMER, checked_at: nowIso() };
    const p0: any = pairs[0]; symbol = p0.baseToken.symbol; name = p0.baseToken.name;
  }
  const terms = [...new Set([symbol, name, query].filter(Boolean) as string[])];
  const seen = new Set<string>(); const allPairs: any[] = [];
  for (const term of terms) {
    const s = await getJson(`${DEX}/search?q=${encodeURIComponent(term)}`);
    for (const p of s.pairs ?? []) {
      const k = p.chainId + ":" + p.pairAddress;
      if (!seen.has(k)) { seen.add(k); allPairs.push(p); }
    }
  }
  const targetSym = (symbol ?? query ?? "").toLowerCase();
  const matched = allPairs.filter((p) =>
    p.baseToken.symbol.toLowerCase() === targetSym ||
    (query && p.baseToken.name.toLowerCase().includes(query.toLowerCase())));
  const map = new Map<string, Candidate>();
  for (const p of (matched.length ? matched : allPairs)) {
    const a = p.baseToken.address;
    const c: Candidate = map.get(a) ?? {
      address: a, name: p.baseToken.name, symbol: p.baseToken.symbol,
      chain: p.chainId, dex: p.dexId, liquidity_usd: 0, volume_24h_usd: 0,
      txns_24h: 0, oldest_pair_at: p.pairCreatedAt ?? null, pair_count: 0,
      pair_url: p.url ?? null, rank: 0, score: 0 };
    c.liquidity_usd += p.liquidity?.usd ?? 0;
    c.volume_24h_usd += p.volume?.h24 ?? 0;
    c.txns_24h += (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0);
    c.pair_count += 1;
    if (p.pairCreatedAt && (!c.oldest_pair_at || p.pairCreatedAt < c.oldest_pair_at))
      c.oldest_pair_at = p.pairCreatedAt;
    map.set(a, c);
  }
  const cands = [...map.values()].map((c) => ({ ...c, score: scoreCand(c) }))
    .sort((a, b) => b.score - a.score);
  const targetName = (name ?? "").toLowerCase();
  const sameName = cands.filter((c) => c.name.toLowerCase() === targetName);
  const ranked = (address && sameName.length ? sameName : cands).map((c, i) => ({ ...c, rank: i + 1 }));
  let verdict = "UNCERTAIN", reason = "No matching tokens found.";
  if (ranked.length === 1) { const r0 = ranked[0]!; verdict = "UNIQUE"; reason = `Only one "${r0.symbol}" token found — no copycat pattern.`; }
  else if (ranked.length > 1 && address) {
    const me = ranked.find((c) => c.address.toLowerCase() === address.toLowerCase());
    if (me && me.rank === 1) { verdict = "LIKELY_ORIGINAL"; reason = `Ranks #1 of ${ranked.length} by liquidity + age + activity — likely the original.`; }
    else if (me) { const r0 = ranked[0]!; verdict = "SUSPECTED_COPYCAT"; reason = `Ranks #${me.rank} of ${ranked.length}; #1 (${r0.address.slice(0, 10)}… on ${r0.chain}) looks like the original.`; }
  } else if (ranked.length > 1) {
    reason = `${ranked.length} tokens share the name — pass an address for a verdict. #1 is the likely original.`;
  }
  const evidence = ranked.slice(0, 10).map((c) =>
    `#${c.rank} ${c.symbol} (${c.name}) on ${c.chain}/${c.dex} — $${Math.round(c.liquidity_usd).toLocaleString()} liq, ${c.txns_24h} txns/24h`);
  return { query: { address, name, symbol }, verdict, verdict_reason: reason,
    candidates: ranked.slice(0, 20), evidence, disclaimer: DISCLAIMER, checked_at: nowIso() };
}

/* ---------------- Sandwich Alarm ---------------- */
async function sandwichAlarm(input: { token?: string; pair?: string; trade_usd?: number }) {
  const token = (input.token ?? "").trim() || null;
  const pairAddr = (input.pair ?? "").trim() || null;
  const tradeUsd = Number(input.trade_usd ?? 1000);
  if (!token && !pairAddr) throw new Error("Provide 'token' or 'pair'.");
  if (!(tradeUsd > 0)) throw new Error("'trade_usd' must be positive.");
  let pairs: any[] = [];
  if (pairAddr) pairs = (await getJson(`${DEX}/pairs/${pairAddr}`)).pairs ?? [];
  else pairs = ((await getJson(`${DEX}/tokens/${token}`)).pairs ?? [])
    .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  if (!pairs.length)
    return { query: { token, pair: pairAddr, trade_usd: tradeUsd }, pair: null,
      verdict: "UNCERTAIN", verdict_reason: "No DexScreener pair found.",
      estimated_price_impact_pct: null, max_safe_trade_usd: null,
      evidence: [], disclaimer: DISCLAIMER, checked_at: nowIso() };
  const p = pairs[0];
  const liq = p.liquidity?.usd ?? 0, vol = p.volume?.h24 ?? 0;
  const txns = (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0);
  const impact = liq > 0 ? (tradeUsd / liq) * 100 : null;
  const maxSafe = liq > 0 ? Math.round(liq * 0.005) : null;
  let verdict = "UNCERTAIN", reason = "No usable liquidity data.";
  if (impact !== null && liq > 0) {
    if (impact >= 2 || (impact >= 0.5 && txns > 500)) { verdict = "DANGER"; reason = `~${impact.toFixed(2)}% price impact — high sandwich risk. Split the trade or use MEV protection.`; }
    else if (impact >= 0.5) { verdict = "CAUTION"; reason = `~${impact.toFixed(2)}% price impact — moderate risk, consider smaller chunks.`; }
    else { verdict = "SAFE"; reason = `~${impact.toFixed(2)}% price impact — too small for profitable sandwiching.`; }
  }
  return { query: { token, pair: pairAddr, trade_usd: tradeUsd },
    pair: { dex: p.dexId, chain: p.chainId, liquidity_usd: liq, volume_24h_usd: vol, txns_24h: txns, pair_url: p.url ?? null },
    verdict, verdict_reason: reason,
    estimated_price_impact_pct: impact !== null ? Math.round(impact * 100) / 100 : null,
    max_safe_trade_usd: maxSafe, evidence: [
      `Pair: ${p.dexId} on ${p.chainId} — $${Math.round(liq).toLocaleString()} liquidity.`,
      impact !== null ? `A $${tradeUsd.toLocaleString()} trade moves price ≈ ${impact.toFixed(2)}%.` : "Liquidity unknown." ],
    disclaimer: DISCLAIMER, checked_at: nowIso() };
}

/* ---------------- Exit Liquidity Detector ---------------- */
async function exitLiquidity(input: { address: string }) {
  const address = (input.address ?? "").trim();
  if (!address) throw new Error("Provide 'address'.");
  const d = await getJson(`${DEX}/tokens/${address}`);
  const pairs: any[] = d.pairs ?? [];
  if (!pairs.length)
    return { query: { address }, token: null, verdict: "UNCERTAIN",
      verdict_reason: "No DexScreener pairs found.", risk_score: 0, signals: [],
      evidence: [], disclaimer: DISCLAIMER, checked_at: nowIso() };
  let liq = 0, vol = 0, buys = 0, sells = 0, priceChg: number | null = null;
  for (const p of pairs) {
    liq += p.liquidity?.usd ?? 0; vol += p.volume?.h24 ?? 0;
    buys += p.txns?.h24?.buys ?? 0; sells += p.txns?.h24?.sells ?? 0;
    if (priceChg === null && p.priceChange?.h24 !== undefined) priceChg = p.priceChange.h24;
  }
  const head: any = pairs[0];
  const signals: { label: string; value: string; risk: string }[] = [];
  let score = 0;
  const sellRatio = (buys + sells) > 0 ? sells / (buys + sells) : 0.5;
  if (sellRatio >= 0.65) { score += 30; signals.push({ label: "Sell pressure", value: `${Math.round(sellRatio * 100)}% sells`, risk: "high" }); }
  else if (sellRatio >= 0.55) { score += 15; signals.push({ label: "Sell pressure", value: `${Math.round(sellRatio * 100)}% sells`, risk: "medium" }); }
  else signals.push({ label: "Sell pressure", value: `${Math.round(sellRatio * 100)}% sells`, risk: "low" });
  const churn = liq > 0 ? vol / liq : 0;
  if (churn >= 5) { score += 25; signals.push({ label: "Churn", value: `${churn.toFixed(1)}x vol/liq`, risk: "high" }); }
  else if (churn >= 2) { score += 12; signals.push({ label: "Churn", value: `${churn.toFixed(1)}x vol/liq`, risk: "medium" }); }
  else signals.push({ label: "Churn", value: `${churn.toFixed(1)}x vol/liq`, risk: "low" });
  if (priceChg !== null) {
    if (priceChg <= -30) { score += 25; signals.push({ label: "Price 24h", value: `${priceChg.toFixed(1)}%`, risk: "high" }); }
    else if (priceChg <= -10) { score += 12; signals.push({ label: "Price 24h", value: `${priceChg.toFixed(1)}%`, risk: "medium" }); }
    else signals.push({ label: "Price 24h", value: `${priceChg.toFixed(1)}%`, risk: "low" });
  }
  if (liq > 0 && liq < 20000) { score += 20; signals.push({ label: "Liquidity depth", value: `$${Math.round(liq).toLocaleString()} — thin`, risk: "high" }); }
  else if (liq > 0 && liq < 100000) { score += 8; signals.push({ label: "Liquidity depth", value: `$${Math.round(liq).toLocaleString()}`, risk: "medium" }); }
  else signals.push({ label: "Liquidity depth", value: `$${Math.round(liq).toLocaleString()}`, risk: "low" });
  score = Math.min(100, Math.round(score));
  const verdict = score >= 60 ? "EXIT_RISK" : score >= 30 ? "WATCH" : "HEALTHY";
  const reason = score >= 60 ? `High dump-risk (${score}/100) — looks like distribution.` :
    score >= 30 ? `Mixed signals (${score}/100) — size carefully.` :
    `No strong distribution signals (${score}/100).`;
  return { query: { address },
    token: { name: head.baseToken.name, symbol: head.baseToken.symbol, chain: head.chainId },
    verdict, verdict_reason: reason, risk_score: score, signals,
    evidence: [`${buys.toLocaleString()} buys vs ${sells.toLocaleString()} sells in 24h across ${pairs.length} pair(s).`],
    disclaimer: DISCLAIMER, checked_at: nowIso() };
}

/* ---------------- Deployer Stalker ---------------- */
const hex = (n: number) => "0x" + n.toString(16);
async function deployerStalker(input: { address: string; chain?: string }) {
  const address = (input.address ?? "").trim();
  if (!isEvmAddr(address)) throw new Error("Provide an EVM address (0x…).");
  const chain = input.chain && RPCS[input.chain] ? input.chain : "base";
  const rpcUrl: string = RPCS[chain] ?? RPCS["base"]!;
  const noTrace = (why: string) => ({
    query: { address, chain }, token: null, deployer: null, verdict: "UNCERTAIN",
    verdict_reason: why, evidence: [], disclaimer: DISCLAIMER, checked_at: nowIso() });
  let deployBlock: number;
  try {
    const latest = parseInt(await rpc(rpcUrl, "eth_blockNumber", []), 16);
    const codeNow: string = await rpc(rpcUrl, "eth_getCode", [address, "latest"]);
    if (!codeNow || codeNow === "0x") return noTrace("No contract code at this address.");
    let lo = 0, hi = latest, guard = 0;
    while (lo < hi && guard++ < 40) {
      const mid = Math.floor((lo + hi) / 2);
      const code: string = await rpc(rpcUrl, "eth_getCode", [address, hex(mid)]);
      if (!code || code === "0x") lo = mid + 1; else hi = mid;
    }
    deployBlock = lo;
  } catch (e) { return noTrace(`Could not trace deployment (${e instanceof Error ? e.message.slice(0, 60) : "RPC error"}).`); }
  let deployer: string | null = null;
  try {
    const block: any = await rpc(rpcUrl, "eth_getBlockByNumber", [hex(deployBlock), true]);
    for (const t of block?.transactions ?? []) {
      if (t.to === null || t.to === undefined) {
        try {
          const rcpt: any = await rpc(rpcUrl, "eth_getTransactionReceipt", [t.hash]);
          if (rcpt?.contractAddress?.toLowerCase() === address.toLowerCase()) { deployer = t.from; break; }
        } catch { /* next */ }
      }
    }
  } catch { /* fall through */ }
  if (!deployer) return noTrace(deployBlock === 0
    ? "Genesis predeploy (block 0) — no deployer transaction exists."
    : "Deployment block found but creation tx could not be isolated.");
  let txCount: number | null = null;
  try { txCount = parseInt(await rpc(rpcUrl, "eth_getTransactionCount", [deployer, "latest"]), 16); } catch { /* optional */ }
  const evidence = [`Deployer: ${deployer} (block ${deployBlock})`,
    `Deployer wallet has ${txCount ?? "unknown"} outgoing tx(s).`];
  let verdict = "CLEAN", reason = `No throwaway pattern: deployer has ${txCount ?? "unknown"} transactions.`;
  if (txCount !== null && txCount <= 2) { verdict = "SUSPICIOUS"; reason = `Throwaway deployer: only ${txCount} tx(s) — classic rug setup.`; }
  else if (txCount !== null && txCount <= 8) { verdict = "SUSPICIOUS"; reason = `Young deployer wallet (${txCount} txs) — elevated risk.`; }
  return { query: { address, chain }, token: null,
    deployer: { address: deployer, tx_count: txCount },
    verdict, verdict_reason: reason, evidence, disclaimer: DISCLAIMER, checked_at: nowIso() };
}

/* ---------------- Approval Audit ---------------- */
async function approvalAudit(input: { wallet: string; chain?: string }) {
  const wallet = (input.wallet ?? "").trim();
  if (!isEvmAddr(wallet)) throw new Error("Provide an EVM wallet address (0x…).");
  const chain = input.chain && COV_CHAINS[input.chain] ? input.chain : "base";
  // Auth: COVALENT_API_KEY env var -> Authorization: Basic base64(key) header,
  // set directly by the plugin (no portal header injection needed).
  const key = process.env.COVALENT_API_KEY;
  if (!key) {
    return { query: { wallet, chain }, status: "needs_api_key", approvals: [],
      summary: { total: 0, unlimited: 0, high_risk: 0 },
      verdict: "Set COVALENT_API_KEY in the portal to activate this check (free at covalenthq.com).",
      evidence: [], disclaimer: DISCLAIMER, checked_at: nowIso() };
  }
  const url = `${COVALENT}/v1/${COV_CHAINS[chain]}/address/${wallet}/approvals/?page-size=100`;
  let d: any;
  try {
    d = await getJsonAuth(url, key);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/40[13]/.test(msg)) {
      return { query: { wallet, chain }, status: "needs_api_key", approvals: [],
        summary: { total: 0, unlimited: 0, high_risk: 0 },
        verdict: "Covalent rejected the API key — check the COVALENT_API_KEY value in the portal (free key at covalenthq.com).",
        evidence: [], disclaimer: DISCLAIMER, checked_at: nowIso() };
    }
    throw e;
  }
  const items: any[] = d?.data?.items ?? [];
  const approvals = items.map((a: any) => {
    const unlimited = (a.allowance ?? "").length > 20;
    return { token: a.token_address ?? null, token_symbol: a.pretty_name ?? null,
      spender: a.spender_address ?? "", allowance: String(a.allowance ?? "0"),
      unlimited, risk: (unlimited ? "high" : "medium") as string };
  });
  const unlimited = approvals.filter((a) => a.unlimited).length;
  return { query: { wallet, chain }, status: "ok", approvals: approvals.slice(0, 50),
    summary: { total: approvals.length, unlimited, high_risk: unlimited },
    verdict: unlimited > 0 ? `${unlimited} unlimited approval(s) — revoke the ones you don't use.` : "No unlimited approvals found.",
    evidence: [`${approvals.length} approval(s) scanned on ${chain}.`],
    disclaimer: DISCLAIMER, checked_at: nowIso() };
}

/* ---------------- MCP server ---------------- */
function toolDef(name: string, title: string, description: string,
  inputSchema: z.ZodTypeAny, outputSchema: z.ZodTypeAny,
  handler: (args: any) => Promise<any>) {
  return { name, title, description, inputSchema, outputSchema, handler };
}
const str = z.string();
const strNull = z.string().nullable();
const numNull = z.number().nullable();

const candidateSchema = z.object({
  address: str, name: str, symbol: str, chain: str, dex: str,
  liquidity_usd: z.number(), volume_24h_usd: z.number(), txns_24h: z.number(),
  oldest_pair_at: numNull, pair_count: z.number(), pair_url: strNull,
  rank: z.number(), score: z.number(),
}).strict();

const tools = [
  toolDef("copycat_hunter", "Copycat Hunter",
    "Detect clone tokens riding a legit name. Pass a token address or a name/symbol query; get a verdict (LIKELY_ORIGINAL / SUSPECTED_COPYCAT / UNIQUE / UNCERTAIN) with ranked candidates from DexScreener market data.",
    z.object({ address: z.string().optional(), query: z.string().optional() }).strict(),
    z.object({ query: z.object({ address: strNull, name: strNull, symbol: strNull }).strict(),
      verdict: str, verdict_reason: str, candidates: z.array(candidateSchema),
      evidence: z.array(str), disclaimer: str, checked_at: str }).strict(),
    copycatHunter),
  toolDef("sandwich_alarm", "Sandwich Alarm",
    "Estimate MEV sandwich risk before a swap. Pass a token or pair address plus trade size in USD; get a verdict (SAFE / CAUTION / DANGER / UNCERTAIN), estimated price impact %, and max safe trade size.",
    z.object({ token: z.string().optional(), pair: z.string().optional(),
      trade_usd: z.number().positive().max(1e12).optional() }).strict(),
    z.object({ query: z.object({ token: strNull, pair: strNull, trade_usd: z.number() }).strict(),
      pair: z.object({ dex: str, chain: str, liquidity_usd: z.number(), volume_24h_usd: z.number(),
        txns_24h: z.number(), pair_url: strNull }).strict().nullable(),
      verdict: str, verdict_reason: str, estimated_price_impact_pct: numNull,
      max_safe_trade_usd: numNull, evidence: z.array(str), disclaimer: str, checked_at: str }).strict(),
    sandwichAlarm),
  toolDef("exit_liquidity_detector", "Exit Liquidity Detector",
    "Ask: are you about to become the exit liquidity? Pass a token address; get a 0-100 dump-risk score with signals (sell pressure, churn, price action, liquidity depth) and a verdict (HEALTHY / WATCH / EXIT_RISK / UNCERTAIN).",
    z.object({ address: z.string().min(1) }).strict(),
    z.object({ query: z.object({ address: str }).strict(),
      token: z.object({ name: str, symbol: str, chain: str }).strict().nullable(),
      verdict: str, verdict_reason: str, risk_score: z.number(),
      signals: z.array(z.object({ label: str, value: str, risk: str }).strict()),
      evidence: z.array(str), disclaimer: str, checked_at: str }).strict(),
    exitLiquidity),
  toolDef("deployer_stalker", "Deployer Stalker",
    "Profile a token's deployer fully onchain — no API key needed. Pass an EVM contract address (base or ethereum); traces the deployment transaction via binary search, then scores the deployer wallet (CLEAN / SUSPICIOUS / UNCERTAIN).",
    z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), chain: z.enum(["base", "ethereum"]).optional() }).strict(),
    z.object({ query: z.object({ address: str, chain: str }).strict(), token: z.any().nullable(),
      deployer: z.object({ address: str, tx_count: numNull }).strict().nullable(),
      verdict: str, verdict_reason: str, evidence: z.array(str), disclaimer: str, checked_at: str }).strict(),
    deployerStalker),
  toolDef("approval_audit", "Approval Audit",
    "Find dangerous token approvals on a wallet. Pass an EVM wallet address; flags unlimited approvals. Requires COVALENT_API_KEY configured in the portal (free at covalenthq.com).",
    z.object({ wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/), chain: z.string().optional() }).strict(),
    z.object({ query: z.object({ wallet: str, chain: str }).strict(), status: str,
      approvals: z.array(z.object({ token: strNull, token_symbol: strNull, spender: str,
        allowance: str, unlimited: z.boolean(), risk: str }).strict()),
      summary: z.object({ total: z.number(), unlimited: z.number(), high_risk: z.number() }).strict(),
      verdict: str, evidence: z.array(str), disclaimer: str, checked_at: str }).strict(),
    approvalAudit),
];

function createServer() {
  const server = new McpServer(
    { name: "agent-bodyguard", version: "1.0.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );
  for (const t of tools) {
    server.registerTool(t.name, {
      title: t.title, description: t.description,
      inputSchema: t.inputSchema, outputSchema: t.outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args: any) => {
      const out = await t.handler(args ?? {});
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
    });
  }
  return server;
}

serveStdio(createServer, { legacy: "reject" });
