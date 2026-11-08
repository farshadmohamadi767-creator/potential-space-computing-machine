import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const inventoryPath = process.env.CAR_LISTINGS_FILE ?? fileURLToPath(new URL("./cars.json", import.meta.url));
const sessions = new Map();

app.use(express.json({ limit: "1mb" }));

function hasValidBearerToken(request) {
  const expected = process.env.MCP_AUTH_TOKEN;
  const authorization = request.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!expected || !match) return false;

  const suppliedDigest = createHash("sha256").update(match[1], "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function requireMcpAuth(request, response, next) {
  if (!hasValidBearerToken(request)) {
    response.set("WWW-Authenticate", "Bearer");
    response.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

app.use("/mcp", requireMcpAuth);

async function loadCars() {
  const contents = await readFile(inventoryPath, "utf8");
  const cars = JSON.parse(contents);
  if (!Array.isArray(cars)) {
    throw new Error("فایل موجودی باید آرایه‌ای از خودروها باشد.");
  }
  return cars;
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function createMcpServer() {
  const server = new McpServer({ name: "Qazvin Smart Car Hunter", version: "1.0.0" });

  server.registerTool(
    "search_cars",
    {
      description: "جست‌وجوی خودروهای ثبت‌شده در موجودی محلی؛ فیلترهای قیمت، سال، سوخت، گیربکس و شهر اختیاری‌اند.",
      inputSchema: {
        query: z.string().optional(),
        location: z.string().optional(),
        minYear: z.number().int().optional(),
        maxYear: z.number().int().optional(),
        maxPrice: z.number().nonnegative().optional(),
        fuel: z.string().optional(),
        transmission: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (filters) => {
      const cars = await loadCars();
      const query = filters.query?.trim().toLocaleLowerCase("fa-IR");
      const matches = cars.filter((car) => {
        const searchable = `${car.make ?? ""} ${car.model ?? ""} ${car.trim ?? ""}`.toLocaleLowerCase("fa-IR");
        return (!query || searchable.includes(query))
          && (!filters.location || car.location?.includes(filters.location))
          && (filters.minYear === undefined || car.year >= filters.minYear)
          && (filters.maxYear === undefined || car.year <= filters.maxYear)
          && (filters.maxPrice === undefined || car.price <= filters.maxPrice)
          && (!filters.fuel || car.fuel === filters.fuel)
          && (!filters.transmission || car.transmission === filters.transmission);
      });
      return textResult({ count: Math.min(matches.length, filters.limit), totalMatches: matches.length, cars: matches.slice(0, filters.limit) });
    },
  );

  server.registerTool(
    "get_car_details",
    {
      description: "دریافت جزئیات یک خودرو از موجودی با شناسهٔ دقیق.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      const car = (await loadCars()).find((item) => item.id === id);
      return textResult(car ?? { error: "خودرویی با این شناسه در موجودی پیدا نشد.", id });
    },
  );

  server.registerTool(
    "compare_cars",
    {
      description: "مقایسهٔ دو تا پنج خودرو با شناسه‌های موجود در فایل موجودی.",
      inputSchema: { ids: z.array(z.string().min(1)).min(2).max(5) },
    },
    async ({ ids }) => {
      const cars = await loadCars();
      const found = ids.map((id) => cars.find((car) => car.id === id) ?? { id, error: "شناسه در موجودی پیدا نشد." });
      return textResult({ cars: found });
    },
  );

  return server;
}

app.get("/health", async (_request, response) => {
  try {
    await loadCars();
    response.json({ status: "ok" });
  } catch {
    response.status(503).json({ status: "unavailable" });
  }
});

app.post("/mcp", async (request, response) => {
  const sessionId = request.headers["mcp-session-id"];
  try {
    if (typeof sessionId === "string") {
      const session = sessions.get(sessionId);
      if (!session) {
        response.status(404).json({ error: "Unknown MCP session" });
        return;
      }
      await session.transport.handleRequest(request, response, request.body);
      return;
    }

    if (!isInitializeRequest(request.body)) {
      response.status(400).json({ error: "A new MCP session must start with an initialize request" });
      return;
    }

    const server = createMcpServer();
    let transport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => sessions.set(id, { server, transport }),
      onsessionclosed: (id) => sessions.delete(id),
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!response.headersSent) response.status(500).json({ error: "MCP request failed" });
  }
});

for (const method of ["get", "delete"]) {
  app[method]("/mcp", async (request, response) => {
    const sessionId = request.headers["mcp-session-id"];
    const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (!session) {
      response.status(404).json({ error: "Unknown MCP session" });
      return;
    }
    await session.transport.handleRequest(request, response);
  });
}

app.listen(port, "0.0.0.0", () => {
  console.log(`Qazvin Smart Car Hunter listening on port ${port}`);
});