# 🛡️ Agent Bodyguard

Five onchain safety tools for token traders — as an **MCP server** and a **pay-per-call x402 API**. Built for the [PayBox / MoonPay hackathon](https://developer.paybox.sh).

> Check before you ape. Agent Bodyguard watches for copycat tokens, sandwich attacks, exit-liquidity traps, suspicious deployers, and dangerous wallet approvals — so your agent (or you) doesn't have to learn the hard way.

## The five tools

| Tool | What it does | x402 price |
|------|--------------|-----------|
| `copycat_hunter` | Finds copycat / lookalike tokens for a query or address; ranks the likely original by liquidity and chain | $0.03 |
| `sandwich_alarm` | Simulates a trade and flags sandwich-attack risk from pool depth and recent swap patterns | $0.02 |
| `exit_liquidity_detector` | Scores exit-liquidity / rug risk: LP concentration, holder distribution, mint & proxy flags | $0.02 |
| `deployer_stalker` | Traces a token's deployer and audits their history for past rugs and suspicious patterns | $0.03 |
| `approval_audit` | Lists a wallet's token approvals and flags unlimited / high-risk spender allowances | $0.05 |

## Live right now

**Paid x402 REST API** (no signup — pay per call in USDC on Base):

```
https://cf-rugcheck.odemakindeezekiel5.workers.dev
```

| Endpoint | Price |
|----------|-------|
| `POST /copycat` | $0.03 |
| `POST /sandwich` | $0.02 |
| `POST /exit-liquidity` | $0.02 |
| `POST /deployer` | $0.03 |
| `POST /approval-audit` | $0.05 |

Example (402 handshake first, then pay via the x402 flow):

```bash
curl -X POST https://cf-rugcheck.odemakindeezekiel5.workers.dev/copycat \
  -H "Content-Type: application/json" \
  -d '{"query": "STREAM"}'
# → 402 Payment Required with payment details; settle and retry
```

**Plugin page:** https://paybox-bodyguard.odemakindeezekiel5.workers.dev

## MCP server

The source in `src/plugin.ts` is a full MCP server (`@modelcontextprotocol/server`) exposing all five tools. A standalone, dependency-light MCP server build is on the way — this repo currently ships the PayBox plugin source as the reference implementation.

```bash
pnpm install
pnpm dev        # run over stdio
pnpm build      # bundle to dist/plugin.mjs
```

### Environment

| Variable | Required | Purpose |
|----------|----------|---------|
| `COVALENT_API_KEY` | only for `approval_audit` | Free key from [covalenthq.com](https://covalenthq.com) |
| `BASE_RPC` | no | Defaults to `https://mainnet.base.org` |
| `ETH_RPC` | no | Defaults to `https://cloudflare-eth.com` |

Without `COVALENT_API_KEY`, `approval_audit` returns a clear `needs_api_key` status instead of failing.

## Architecture

```
src/plugin.ts      MCP server — all five tools, input validation (zod), rate-limit retries
src/paybox.ts      PayBox marketplace plugin wiring
```

Data sources: DexScreener (pairs/liquidity), public RPCs (Base, Ethereum), Covalent GoldRush (approvals). No private keys, no custodial anything — read-only safety checks.

## Roadmap

- [x] PayBox marketplace plugin (submitted to the MoonPay hackathon)
- [x] x402 paid REST API on Cloudflare Workers
- [ ] Standalone MCP server package (`src/mcp-server.ts`) — in progress
- [ ] Listings on Smithery, Glama, mcp.so, PulseMCP
- [ ] More chains (Solana via DexScreener, Arbitrum, Polygon)

## License

MIT — built by [@nostoryboss](https://x.com/nostoryboss).
