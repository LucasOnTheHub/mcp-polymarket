/**
 * Polymarket Analysis MCP Server v3.0
 * ─────────────────────────────────────────────────────────────
 * Triple API, fully public — no wallet, no authentication:
 *   • Gamma API  → market discovery, prices, events, tags, series
 *   • CLOB API   → orderbook depth, price history
 *   • Data API   → trades feed, holders, wallet positions, activity
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "http";
import { URL } from "url";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB  = "https://clob.polymarket.com";
const DATA  = "https://data-api.polymarket.com";

// ── Fetch helpers ────────────────────────────────────────────
async function get(base: string, path: string, params: Record<string, string | number | boolean | undefined> = {}) {
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json();
}

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json();
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({
  name: "polymarket-analysis",
  version: "3.0.0",
  description: "Polymarket full analytics — Gamma + CLOB + Data API, no authentication required",
});

// ════════════════════════════════════════════════════════════
// GAMMA API — Market discovery & analytics
// ════════════════════════════════════════════════════════════

server.tool(
  "poly_list_markets",
  "List markets with filters. Returns prices, volumes, liquidity, bid/ask, spread and price changes per period.",
  {
    active:        z.boolean().optional().default(true),
    closed:        z.boolean().optional().default(false),
    limit:         z.number().int().min(1).max(100).optional().default(20),
    offset:        z.number().int().optional().default(0),
    order:         z.enum(["volume", "volume24hr", "liquidity", "createdAt", "endDate"]).optional().default("volume24hr"),
    ascending:     z.boolean().optional().default(false),
    tag:           z.string().optional().describe("Tag slug filter (e.g. 'crypto', 'politics', 'sports')"),
    liquidity_min: z.number().optional().describe("Minimum liquidity in USD"),
  },
  async ({ active, closed, limit, offset, order, ascending, tag, liquidity_min }) =>
    ok(await get(GAMMA, "/markets", { active, closed, limit, offset, order, ascending, tag_slug: tag, liquidity_num_min: liquidity_min }))
);

server.tool(
  "poly_search_markets",
  "Full-text search across all Polymarket markets.",
  {
    q:      z.string().describe("Keyword (e.g. 'bitcoin', 'fed rate', 'world cup')"),
    active: z.boolean().optional().default(true),
    limit:  z.number().int().min(1).max(50).optional().default(10),
  },
  async ({ q, active, limit }) => ok(await get(GAMMA, "/markets", { q, active, limit }))
);

server.tool(
  "poly_market_snapshot",
  "Full analytical snapshot of a market: prices, spread, volumes (24h/1w/1mo), liquidity, price changes (1h/1d/1w/1m/1y), CLOB token IDs.",
  {
    slug:         z.string().optional().describe("Market slug (e.g. 'will-btc-hit-100k')"),
    condition_id: z.string().optional().describe("Condition ID (0x...)"),
  },
  async ({ slug, condition_id }) => {
    if (!slug && !condition_id) throw new Error("Provide slug or condition_id");
    const params: Record<string, string> = {};
    if (slug)         params.slug         = slug;
    if (condition_id) params.condition_id = condition_id;
    const data = await get(GAMMA, "/markets", params) as Record<string, unknown>[];
    if (!data?.length) throw new Error("Market not found");
    const m = data[0];
    return ok({
      question: m.question, category: m.category, endDate: m.endDateIso,
      active: m.active, closed: m.closed,
      lastTradePrice: m.lastTradePrice, bestBid: m.bestBid, bestAsk: m.bestAsk,
      spread: m.spread, outcomePrices: m.outcomePrices,
      volume: m.volume, volume24hr: m.volume24hr, volume1wk: m.volume1wk, volume1mo: m.volume1mo,
      liquidity: m.liquidity, competitive: m.competitive,
      priceChange1h: m.oneHourPriceChange, priceChange1d: m.oneDayPriceChange,
      priceChange1w: m.oneWeekPriceChange, priceChange1m: m.oneMonthPriceChange,
      priceChange1y: m.oneYearPriceChange,
      clobTokenIds: m.clobTokenIds, conditionId: m.conditionId,
    });
  }
);

server.tool(
  "poly_top_movers",
  "Markets with the highest absolute price change over a period. Spot trending bets in real time.",
  {
    period:       z.enum(["1h", "1d", "1w", "1m"]).optional().default("1d"),
    limit:        z.number().int().min(1).max(50).optional().default(10),
    liquidity_min: z.number().optional().default(1000),
  },
  async ({ period, limit, liquidity_min }) => {
    const fieldMap: Record<string, string> = {
      "1h": "oneHourPriceChange", "1d": "oneDayPriceChange",
      "1w": "oneWeekPriceChange", "1m": "oneMonthPriceChange",
    };
    const data = await get(GAMMA, "/markets", { active: true, limit: 200, liquidity_num_min: liquidity_min, order: "volume", ascending: false }) as Record<string, unknown>[];
    const arr = Array.isArray(data) ? data : (data as { data: Record<string, unknown>[] }).data ?? [];
    const field = fieldMap[period];
    const sorted = arr
      .filter(m => m[field] !== null && m[field] !== undefined)
      .sort((a, b) => Math.abs(Number(b[field])) - Math.abs(Number(a[field])))
      .slice(0, limit)
      .map(m => ({ question: m.question, slug: m.slug, priceChange: m[field], lastTradePrice: m.lastTradePrice, bestBid: m.bestBid, bestAsk: m.bestAsk, liquidity: m.liquidity, volume24hr: m.volume24hr }));
    return ok({ period, movers: sorted });
  }
);

server.tool(
  "poly_list_events",
  "List events (themed groups of related markets). Use for macro topics like 'World Cup', 'US Election', 'Fed rate'.",
  {
    active:  z.boolean().optional().default(true),
    limit:   z.number().int().min(1).max(50).optional().default(10),
    offset:  z.number().int().optional().default(0),
    order:   z.enum(["volume", "liquidity", "createdAt", "endDate"]).optional().default("volume"),
    tag:     z.string().optional(),
    q:       z.string().optional().describe("Keyword search"),
  },
  async ({ active, limit, offset, order, tag, q }) =>
    ok(await get(GAMMA, "/events", { active, limit, offset, order, tag_slug: tag, q }))
);

server.tool(
  "poly_get_event",
  "Get a single event and all its constituent markets.",
  { slug: z.string() },
  async ({ slug }) => ok(await get(GAMMA, "/events", { slug }))
);

server.tool(
  "poly_tags",
  "List all available market categories/tags (e.g. crypto, politics, sports, science, pop culture).",
  { limit: z.number().int().optional().default(100) },
  async ({ limit }) => ok(await get(GAMMA, "/tags", { limit }))
);

server.tool(
  "poly_series",
  "List recurring market series (e.g. earnings seasons, sports leagues, recurring events).",
  {
    active: z.boolean().optional().default(true),
    limit:  z.number().int().optional().default(20),
  },
  async ({ active, limit }) => ok(await get(GAMMA, "/series", { active, limit }))
);

// ════════════════════════════════════════════════════════════
// CLOB API — Orderbook depth & price history (public)
// ════════════════════════════════════════════════════════════

server.tool(
  "poly_orderbook",
  "Live CLOB orderbook (bids/asks) for a token. Use clobTokenIds from poly_market_snapshot.",
  { token_id: z.string() },
  async ({ token_id }) => {
    const data = await get(CLOB, "/book", { token_id }) as Record<string, unknown>;
    const bids = (data.bids as { price: string; size: string }[]) ?? [];
    const asks = (data.asks as { price: string; size: string }[]) ?? [];
    return ok({ token_id, bids_count: bids.length, asks_count: asks.length, best_bid: bids[0] ?? null, best_ask: asks[0] ?? null, top5_bids: bids.slice(0, 5), top5_asks: asks.slice(0, 5), full_book: data });
  }
);

server.tool(
  "poly_orderbooks_batch",
  "Orderbooks for multiple tokens at once (max 20). Useful for comparing YES/NO sides or multiple markets.",
  { token_ids: z.array(z.string()).min(1).max(20) },
  async ({ token_ids }) => ok(await post(CLOB, "/books", token_ids.map(id => ({ token_id: id }))))
);

server.tool(
  "poly_price_history",
  "Historical price timeseries for a CLOB token. Use token_id from clobTokenIds.",
  {
    token_id: z.string(),
    interval: z.enum(["1m", "1h", "6h", "1d", "1w", "1mo", "max"]).optional().default("1d"),
    start_ts: z.number().optional().describe("Unix timestamp start"),
    end_ts:   z.number().optional().describe("Unix timestamp end"),
  },
  async ({ token_id, interval, start_ts, end_ts }) =>
    ok(await get(CLOB, "/prices-history", { market: token_id, interval, startTs: start_ts, endTs: end_ts }))
);

// ════════════════════════════════════════════════════════════
// DATA API — Trades, holders, wallet analytics (public)
// ════════════════════════════════════════════════════════════

server.tool(
  "poly_market_trades",
  "Recent trades on a specific market. Shows price, size, side (BUY/SELL), wallet, timestamp for each trade.",
  {
    condition_id: z.string().describe("Market condition ID (0x...)"),
    limit:        z.number().int().min(1).max(100).optional().default(20),
    offset:       z.number().int().optional().default(0),
  },
  async ({ condition_id, limit, offset }) =>
    ok(await get(DATA, "/trades", { market: condition_id, limit, offset }))
);

server.tool(
  "poly_global_trades",
  "Global real-time trade feed across all Polymarket markets. Useful for monitoring overall market activity.",
  {
    limit:  z.number().int().min(1).max(50).optional().default(20),
    offset: z.number().int().optional().default(0),
  },
  async ({ limit, offset }) => ok(await get(DATA, "/trades", { limit, offset }))
);

server.tool(
  "poly_market_holders",
  "Top token holders for a market. Shows wallet, position size, entry price and PnL for each holder.",
  {
    condition_id: z.string().describe("Market condition ID (0x...)"),
    limit:        z.number().int().min(1).max(100).optional().default(20),
    offset:       z.number().int().optional().default(0),
  },
  async ({ condition_id, limit, offset }) =>
    ok(await get(DATA, "/holders", { market: condition_id, limit, offset }))
);

server.tool(
  "poly_wallet_positions",
  "All open positions for any wallet address: size, avg entry price, current value, unrealized and realized PnL.",
  {
    wallet:  z.string().describe("Wallet address (0x...)"),
    limit:   z.number().int().min(1).max(100).optional().default(20),
    offset:  z.number().int().optional().default(0),
  },
  async ({ wallet, limit, offset }) =>
    ok(await get(DATA, "/positions", { user: wallet, limit, offset }))
);

server.tool(
  "poly_wallet_activity",
  "Full trading activity history for any wallet: trades, deposits, withdrawals with timestamps and market context.",
  {
    wallet:  z.string().describe("Wallet address (0x...)"),
    limit:   z.number().int().min(1).max(100).optional().default(20),
    offset:  z.number().int().optional().default(0),
  },
  async ({ wallet, limit, offset }) =>
    ok(await get(DATA, "/activity", { user: wallet, limit, offset }))
);

server.tool(
  "poly_wallet_value",
  "Current portfolio value for any wallet address.",
  { wallet: z.string().describe("Wallet address (0x...)") },
  async ({ wallet }) => ok(await get(DATA, "/value", { user: wallet }))
);

server.tool(
  "poly_wallet_trades",
  "Trade history for a specific wallet. Filter by market or get all trades across all markets.",
  {
    wallet:       z.string().describe("Wallet address (0x...)"),
    condition_id: z.string().optional().describe("Filter by market condition ID"),
    limit:        z.number().int().min(1).max(100).optional().default(20),
    offset:       z.number().int().optional().default(0),
  },
  async ({ wallet, condition_id, limit, offset }) =>
    ok(await get(DATA, "/trades", { user: wallet, market: condition_id, limit, offset }))
);

// ════════════════════════════════════════════════════════════
// HTTP server
// ════════════════════════════════════════════════════════════
const PORT = parseInt(process.env.PORT || "3000");
const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url!, `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok", server: "polymarket-analysis-mcp", version: "3.0.0",
      sources: ["gamma-api.polymarket.com", "clob.polymarket.com", "data-api.polymarket.com"],
      tools: 18, auth: "none",
    }));
    return;
  }

  if (url.pathname === "/mcp") {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, await readBody(req));
    } catch (err) {
      if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); }
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Use /mcp or /health" }));
});

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Polymarket Analysis MCP v3.0 on :${PORT}`);
  console.log(`APIs: Gamma + CLOB + Data | Tools: 18 | Auth: none`);
});
