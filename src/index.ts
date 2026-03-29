/**
 * Polymarket CLOB MCP Server
 * REST wrapper for https://clob.polymarket.com
 * Public endpoints (L0) + Authenticated endpoints (L2 via HMAC-SHA256)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "http";
import { createHmac } from "crypto";
import { URL } from "url";

const CLOB_BASE = "https://clob.polymarket.com";
const API_KEY    = process.env.POLY_API_KEY    || "";
const API_SECRET = process.env.POLY_API_SECRET || "";
const API_PASS   = process.env.POLY_API_PASS   || "";

function buildL2Headers(method: string, path: string, body = ""): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const message = ts + method.toUpperCase() + path + body;
  const sig = createHmac("sha256", Buffer.from(API_SECRET, "base64"))
    .update(message).digest("base64");
  return {
    "Content-Type": "application/json",
    "POLY-API-KEY": API_KEY,
    "POLY-TIMESTAMP": ts,
    "POLY-SIGNATURE": sig,
    "POLY-PASSPHRASE": API_PASS,
  };
}

async function clobGet(path: string, params: Record<string, string | number | undefined> = {}, auth = false) {
  const url = new URL(`${CLOB_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = auth
    ? buildL2Headers("GET", path + (url.search || ""))
    : { "Content-Type": "application/json" };
  const res = await fetch(url.toString(), { headers });
  if (!res.ok) throw new Error(`CLOB ${res.status}: ${await res.text()}`);
  return res.json();
}

async function clobPost(path: string, body: unknown, auth = true) {
  const raw = JSON.stringify(body);
  const headers = auth ? buildL2Headers("POST", path, raw) : { "Content-Type": "application/json" };
  const res = await fetch(`${CLOB_BASE}${path}`, { method: "POST", headers, body: raw });
  if (!res.ok) throw new Error(`CLOB POST ${res.status}: ${await res.text()}`);
  return res.json();
}

async function clobDelete(path: string, body?: unknown, auth = true) {
  const raw = body ? JSON.stringify(body) : "";
  const headers = auth ? buildL2Headers("DELETE", path, raw) : { "Content-Type": "application/json" };
  const res = await fetch(`${CLOB_BASE}${path}`, { method: "DELETE", headers, ...(raw ? { body: raw } : {}) });
  if (!res.ok) throw new Error(`CLOB DELETE ${res.status}: ${await res.text()}`);
  return res.json();
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function hasL2() { return !!(API_KEY && API_SECRET && API_PASS); }

function requireL2() {
  if (!hasL2()) return { content: [{ type: "text" as const, text: JSON.stringify({
    error: "L2 auth required. Set POLY_API_KEY, POLY_API_SECRET, POLY_API_PASS env vars."
  }) }] };
  return null;
}

const server = new McpServer({
  name: "polymarket-clob",
  version: "1.0.0",
  description: "Polymarket CLOB API — order book, trading, positions (clob.polymarket.com)"
});

// ── PUBLIC (L0) ──
server.tool("polymarket_status", "CLOB API health check", {}, async () => ok(await clobGet("/")));
server.tool("polymarket_server_time", "CLOB server timestamp", {}, async () => ok(await clobGet("/time")));

server.tool("polymarket_get_markets", "List CLOB markets (paginated). Returns token IDs, tick sizes, accepting_orders.",
  { next_cursor: z.string().optional().describe("Pagination cursor") },
  async ({ next_cursor }) => ok(await clobGet("/markets", { next_cursor }))
);

server.tool("polymarket_get_market", "Get CLOB market by condition ID",
  { condition_id: z.string().describe("Market condition ID (hex)") },
  async ({ condition_id }) => ok(await clobGet(`/markets/${condition_id}`))
);

server.tool("polymarket_get_orderbook", "Get live order book (bids/asks) for a token",
  { token_id: z.string().describe("Token ID (YES or NO outcome)") },
  async ({ token_id }) => ok(await clobGet("/book", { token_id }))
);

server.tool("polymarket_get_orderbooks", "Get order books for multiple tokens",
  { token_ids: z.array(z.string()).min(1).max(20) },
  async ({ token_ids }) => ok(await clobPost("/books", token_ids.map(id => ({ token_id: id })), false))
);

server.tool("polymarket_get_price", "Get best bid or ask for a token",
  { token_id: z.string(), side: z.enum(["BUY", "SELL"]).describe("BUY=best ask, SELL=best bid") },
  async ({ token_id, side }) => ok(await clobGet("/price", { token_id, side }))
);

server.tool("polymarket_get_prices", "Get prices for multiple tokens",
  { token_ids: z.array(z.string()).min(1), side: z.enum(["BUY", "SELL"]) },
  async ({ token_ids, side }) => ok(await clobPost("/prices", token_ids.map(id => ({ token_id: id, side })), false))
);

server.tool("polymarket_get_midpoint", "Get midpoint price for a token",
  { token_id: z.string() },
  async ({ token_id }) => ok(await clobGet("/midpoint", { token_id }))
);

server.tool("polymarket_get_spread", "Get bid-ask spread for a token",
  { token_id: z.string() },
  async ({ token_id }) => ok(await clobGet("/spread", { token_id }))
);

server.tool("polymarket_get_last_trade_price", "Last trade price for a token",
  { token_id: z.string() },
  async ({ token_id }) => ok(await clobGet("/last-trade-price", { token_id }))
);

server.tool("polymarket_get_price_history", "Historical price timeseries for a token",
  {
    token_id: z.string(),
    interval: z.enum(["1m", "1h", "1d", "1w", "1mo", "max"]).optional().default("1d"),
    startTs: z.number().optional().describe("Unix timestamp start"),
    endTs: z.number().optional().describe("Unix timestamp end"),
  },
  async ({ token_id, interval, startTs, endTs }) =>
    ok(await clobGet("/prices-history", { market: token_id, interval, startTs, endTs }))
);

// ── AUTHENTICATED (L2) ──
server.tool("polymarket_get_open_orders", "Your open orders. L2 required.",
  { market: z.string().optional(), token_id: z.string().optional() },
  async ({ market, token_id }) => {
    const err = requireL2(); if (err) return err;
    const p: Record<string, string | undefined> = {};
    if (market)   p.market   = market;
    if (token_id) p.asset_id = token_id;
    return ok(await clobGet("/data/orders", p, true));
  }
);

server.tool("polymarket_get_order", "Get order by hash. L2 required.",
  { order_id: z.string().describe("Order hash 0x...") },
  async ({ order_id }) => {
    const err = requireL2(); if (err) return err;
    return ok(await clobGet(`/data/order/${order_id}`, {}, true));
  }
);

server.tool("polymarket_get_trades", "Your trade history. L2 required.",
  { market: z.string().optional(), token_id: z.string().optional(), limit: z.number().int().optional().default(50) },
  async ({ market, token_id, limit }) => {
    const err = requireL2(); if (err) return err;
    return ok(await clobGet("/data/trades", { market, asset_id: token_id, limit }, true));
  }
);

server.tool("polymarket_post_order",
  "Place a signed limit order. L2 required. Order must be pre-signed via py-clob-client or @polymarket/clob-client.",
  { order: z.object({}).passthrough(), orderType: z.enum(["GTC", "GTD", "FOK", "FAK"]).default("GTC") },
  async ({ order, orderType }) => {
    const err = requireL2(); if (err) return err;
    return ok(await clobPost("/order", { order, orderType }));
  }
);

server.tool("polymarket_post_orders_batch", "Place up to 15 orders at once. L2 required.",
  { orders: z.array(z.object({ order: z.object({}).passthrough(), orderType: z.enum(["GTC","GTD","FOK","FAK"]).default("GTC") })).min(1).max(15) },
  async ({ orders }) => {
    const err = requireL2(); if (err) return err;
    return ok(await clobPost("/orders", orders));
  }
);

server.tool("polymarket_cancel_order", "Cancel one order. L2 required.",
  { order_id: z.string() },
  async ({ order_id }) => {
    const err = requireL2(); if (err) return err;
    return ok(await clobDelete(`/order/${order_id}`));
  }
);

server.tool("polymarket_cancel_orders", "Cancel multiple orders. L2 required.",
  { order_ids: z.array(z.string()).min(1) },
  async ({ order_ids }) => {
    const err = requireL2(); if (err) return err;
    return ok(await clobDelete("/orders", order_ids));
  }
);

server.tool("polymarket_cancel_market_orders", "Cancel all orders for a market. L2 required.",
  { market: z.string(), asset_id: z.string().optional() },
  async ({ market, asset_id }) => {
    const err = requireL2(); if (err) return err;
    const body: Record<string, string> = { market };
    if (asset_id) body.asset_id = asset_id;
    return ok(await clobDelete("/cancel-market-orders", body));
  }
);

server.tool("polymarket_cancel_all", "Cancel ALL open orders. L2 required. WARNING: kills every position.",
  {},
  async () => {
    const err = requireL2(); if (err) return err;
    return ok(await clobDelete("/cancel-all"));
  }
);

server.tool("polymarket_derive_api_key",
  "How to generate CLOB L2 API credentials from your wallet (one-time setup)",
  {},
  async () => ok({
    info: "Run once to derive your API key:",
    python: [
      "pip install py-clob-client",
      "from py_clob_client.client import ClobClient",
      "client = ClobClient('https://clob.polymarket.com', key='<PRIVATE_KEY>', chain_id=137, signature_type=1, funder='<FUNDER_ADDRESS>')",
      "creds = client.create_or_derive_api_creds()",
      "print(creds)"
    ],
    env_vars: {
      POLY_API_KEY: "creds.api_key",
      POLY_API_SECRET: "creds.api_secret",
      POLY_API_PASS: "creds.api_passphrase"
    },
    funder_address: "0xee1a210374bf03b03364d5dcca00190994ba6529"
  })
);

// ── HTTP server ──
const PORT = parseInt(process.env.PORT || "3000");
const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url!, `http://localhost:${PORT}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "polymarket-clob-mcp", l2_auth: hasL2() ? "configured" : "read-only" }));
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
  res.writeHead(404); res.end(JSON.stringify({ error: "Use /mcp or /health" }));
});
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const c: Buffer[] = [];
    req.on("data", x => c.push(x));
    req.on("end", () => resolve(Buffer.concat(c)));
    req.on("error", reject);
  });
}
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Polymarket CLOB MCP on :${PORT} | L2: ${hasL2() ? "OK" : "read-only"}`);
});
