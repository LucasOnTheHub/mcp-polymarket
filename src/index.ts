/**
 * Polymarket Analysis MCP Server
 * Hybrid: Gamma API (rich market data) + CLOB API (orderbook depth)
 * Fully public — no authentication required
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "http";
import { URL } from "url";

const GAMMA  = "https://gamma-api.polymarket.com";
const CLOB   = "https://clob.polymarket.com";

// ── Generic fetch helpers ────────────────────────────────────
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

// ── MCP server ───────────────────────────────────────────────
const server = new McpServer({
  name: "polymarket-analysis",
  version: "2.0.0",
  description: "Polymarket full market data — Gamma API + CLOB orderbook depth, no auth required",
});

// ════════════════════════════════════════════════════════════
// GAMMA — Market discovery & analytics
// ════════════════════════════════════════════════════════════

server.tool(
  "poly_list_markets",
  "List Polymarket markets with filters. Returns prices, volume, liquidity, bid/ask, price changes.",
  {
    active:      z.boolean().optional().default(true).describe("Only active markets"),
    closed:      z.boolean().optional().default(false).describe("Include closed markets"),
    limit:       z.number().int().min(1).max(100).optional().default(20),
    offset:      z.number().int().optional().default(0),
    order:       z.enum(["volume", "volume24hr", "liquidity", "createdAt", "endDate"]).optional().default("volume"),
    ascending:   z.boolean().optional().default(false),
    tag:         z.string().optional().describe("Filter by tag/category (e.g. 'crypto', 'politics', 'sports')"),
    liquidity_min: z.number().optional().describe("Minimum liquidity in USD"),
  },
  async ({ active, closed, limit, offset, order, ascending, tag, liquidity_min }) =>
    ok(await get(GAMMA, "/markets", {
      active, closed, limit, offset,
      order, ascending,
      tag_slug: tag,
      liquidity_num_min: liquidity_min,
    }))
);

server.tool(
  "poly_search_markets",
  "Full-text search across Polymarket markets by keyword.",
  {
    q:      z.string().describe("Search query (e.g. 'bitcoin', 'election', 'world cup')"),
    active: z.boolean().optional().default(true),
    limit:  z.number().int().min(1).max(50).optional().default(10),
  },
  async ({ q, active, limit }) =>
    ok(await get(GAMMA, "/markets", { q, active, limit }))
);

server.tool(
  "poly_get_market",
  "Get a single market by slug or condition ID. Returns full analytics: prices, volume, liquidity, bid/ask, spread, price changes (1h/1d/1w/1m).",
  {
    slug:         z.string().optional().describe("Market slug (from URL, e.g. 'will-btc-hit-100k')"),
    condition_id: z.string().optional().describe("Condition ID (hex 0x...)"),
  },
  async ({ slug, condition_id }) => {
    if (!slug && !condition_id) throw new Error("Provide slug or condition_id");
    const params: Record<string, string> = {};
    if (slug)         params.slug         = slug;
    if (condition_id) params.condition_id = condition_id;
    return ok(await get(GAMMA, "/markets", params));
  }
);

server.tool(
  "poly_list_events",
  "List Polymarket events (groups of related markets). Good for finding all markets in a theme (e.g. 'World Cup 2026').",
  {
    active:  z.boolean().optional().default(true),
    limit:   z.number().int().min(1).max(50).optional().default(10),
    offset:  z.number().int().optional().default(0),
    order:   z.enum(["volume", "liquidity", "createdAt", "endDate"]).optional().default("volume"),
    tag:     z.string().optional().describe("Filter by tag"),
  },
  async ({ active, limit, offset, order, tag }) =>
    ok(await get(GAMMA, "/events", { active, limit, offset, order, tag_slug: tag }))
);

server.tool(
  "poly_get_event",
  "Get a single event with all its markets by event slug.",
  { slug: z.string().describe("Event slug") },
  async ({ slug }) => ok(await get(GAMMA, "/events", { slug }))
);

server.tool(
  "poly_top_movers",
  "Markets with highest price change over a given period. Great for spotting trending bets.",
  {
    period:  z.enum(["1h", "1d", "1w", "1m"]).optional().default("1d").describe("Price change period"),
    limit:   z.number().int().min(1).max(50).optional().default(10),
    active:  z.boolean().optional().default(true),
    min_liquidity: z.number().optional().default(1000).describe("Minimum liquidity USD to filter noise"),
  },
  async ({ period, limit, active, min_liquidity }) => {
    const fieldMap: Record<string, string> = {
      "1h": "oneHourPriceChange",
      "1d": "oneDayPriceChange",
      "1w": "oneWeekPriceChange",
      "1m": "oneMonthPriceChange",
    };
    const data = await get(GAMMA, "/markets", {
      active, limit: 200, liquidity_num_min: min_liquidity,
      order: "volume", ascending: false,
    }) as unknown[];
    const arr = Array.isArray(data) ? data : (data as { data: unknown[] }).data ?? [];
    const field = fieldMap[period];
    const sorted = (arr as Record<string, unknown>[])
      .filter(m => m[field] !== undefined && m[field] !== null)
      .sort((a, b) => Math.abs(Number(b[field])) - Math.abs(Number(a[field])))
      .slice(0, limit)
      .map(m => ({
        question: m.question,
        slug: m.slug,
        priceChange: m[field],
        lastTradePrice: m.lastTradePrice,
        bestBid: m.bestBid,
        bestAsk: m.bestAsk,
        liquidity: m.liquidity,
        volume24hr: m.volume24hr,
      }));
    return ok({ period, movers: sorted });
  }
);

server.tool(
  "poly_market_snapshot",
  "Full analytical snapshot of a market: prices, volume breakdown, bid/ask, spread, price changes across all periods.",
  { slug: z.string().describe("Market slug") },
  async ({ slug }) => {
    const data = await get(GAMMA, "/markets", { slug }) as Record<string, unknown>[];
    if (!data?.length) throw new Error(`Market not found: ${slug}`);
    const m = data[0];
    return ok({
      question:            m.question,
      category:            m.category,
      endDate:             m.endDateIso,
      active:              m.active,
      closed:              m.closed,
      // Pricing
      lastTradePrice:      m.lastTradePrice,
      bestBid:             m.bestBid,
      bestAsk:             m.bestAsk,
      spread:              m.spread,
      outcomePrices:       m.outcomePrices,
      // Volume
      volume:              m.volume,
      volume24hr:          m.volume24hr,
      volume1wk:           m.volume1wk,
      volume1mo:           m.volume1mo,
      // Liquidity
      liquidity:           m.liquidity,
      competitive:         m.competitive,
      // Price changes
      priceChange1h:       m.oneHourPriceChange,
      priceChange1d:       m.oneDayPriceChange,
      priceChange1w:       m.oneWeekPriceChange,
      priceChange1m:       m.oneMonthPriceChange,
      priceChange1y:       m.oneYearPriceChange,
      // CLOB info
      clobTokenIds:        m.clobTokenIds,
      conditionId:         m.conditionId,
    });
  }
);

// ════════════════════════════════════════════════════════════
// CLOB — Orderbook depth & trade data (public, no auth)
// ════════════════════════════════════════════════════════════

server.tool(
  "poly_orderbook",
  "Get CLOB order book (bids/asks) for a token. Use clobTokenIds from poly_market_snapshot to get the token ID.",
  { token_id: z.string().describe("CLOB token ID (from clobTokenIds field of a market)") },
  async ({ token_id }) => {
    const data = await get(CLOB, "/book", { token_id }) as Record<string, unknown>;
    const bids = (data.bids as { price: string; size: string }[]) ?? [];
    const asks = (data.asks as { price: string; size: string }[]) ?? [];
    return ok({
      token_id,
      bids_count: bids.length,
      asks_count: asks.length,
      best_bid:   bids[0]  ?? null,
      best_ask:   asks[0]  ?? null,
      top5_bids:  bids.slice(0, 5),
      top5_asks:  asks.slice(0, 5),
      full_book:  data,
    });
  }
);

server.tool(
  "poly_orderbooks_batch",
  "Get CLOB order books for multiple tokens at once (max 20).",
  { token_ids: z.array(z.string()).min(1).max(20) },
  async ({ token_ids }) =>
    ok(await post(CLOB, "/books", token_ids.map(id => ({ token_id: id }))))
);

server.tool(
  "poly_last_trade_price",
  "Get last traded price for a CLOB token.",
  { token_id: z.string() },
  async ({ token_id }) => ok(await get(CLOB, "/last-trade-price", { token_id }))
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
    ok(await get(CLOB, "/prices-history", {
      market: token_id, interval,
      startTs: start_ts, endTs: end_ts,
    }))
);

server.tool(
  "poly_clob_markets",
  "List CLOB markets (paginated). Useful for finding markets with active order books.",
  {
    next_cursor: z.string().optional().describe("Pagination cursor from previous call"),
    limit:       z.number().int().optional().default(20),
  },
  async ({ next_cursor, limit }) =>
    ok(await get(CLOB, "/markets", { next_cursor, limit }))
);

server.tool(
  "poly_clob_market",
  "Get a single CLOB market by condition ID.",
  { condition_id: z.string().describe("Condition ID (hex 0x...)") },
  async ({ condition_id }) => ok(await get(CLOB, `/markets/${condition_id}`))
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
      status: "ok",
      server: "polymarket-analysis-mcp",
      version: "2.0.0",
      sources: ["gamma-api.polymarket.com", "clob.polymarket.com"],
      auth: "none",
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
  console.log(`Polymarket Analysis MCP v2.0 on :${PORT}`);
  console.log(`Sources: Gamma API + CLOB API (no auth)`);
});
