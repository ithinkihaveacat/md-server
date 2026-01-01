#!/usr/bin/env node

import http, { IncomingMessage, ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Product schema for display_product tool
// Only title, price, and currency are required; all other fields are optional
const ProductSchema = z.object({
  // Required fields
  title: z.string().describe("Product name"),
  price: z.number().describe("Current price"),
  currency: z.string().describe("Currency code (GBP, USD, EUR, etc.)"),
  // Optional base fields
  store: z.string().optional().describe("Store identifier"),
  brand: z.string().optional().describe("Manufacturer/vendor"),
  product_url: z.string().optional().describe("Link to product page"),
  image_url: z.string().optional().describe("Product image URL"),
  variant: z.string().optional().describe("Variant description"),
  size: z.string().optional().describe("Size value"),
  color: z.string().optional().describe("Color value"),
  compare_at_price: z.number().optional().describe("Original price if on sale"),
  discount_percent: z.number().optional().describe("Discount percentage"),
  savings: z.number().optional().describe("Savings amount"),
  available: z.boolean().optional().describe("Whether in stock"),
  // Optional event fields
  first_seen_at: z.string().optional().describe("When product was added"),
  became_available_at: z.string().optional().describe("When item restocked"),
  previous_price: z.number().optional().describe("Price before drop"),
  event_timestamp: z.string().optional().describe("When event occurred"),
});

type Product = z.infer<typeof ProductSchema>;

// Parse command line arguments
const { values } = parseArgs({
  options: {
    port: {
      type: "string",
      short: "p",
      default: process.env.PORT || "8080",
    },
  },
});

const PORT = parseInt(values.port!, 10);

// Store current markdown content
let currentContent = "";

// Track SSE clients
const clients = new Set<ServerResponse>();

// HTML page with embedded markdown renderer
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Markdown Viewer</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      color: #333;
    }
    pre {
      background: #f4f4f4;
      padding: 12px;
      border-radius: 4px;
      overflow-x: auto;
    }
    code {
      background: #f4f4f4;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'SF Mono', Consolas, monospace;
    }
    pre code {
      background: none;
      padding: 0;
    }
    blockquote {
      border-left: 4px solid #ddd;
      margin-left: 0;
      padding-left: 16px;
      color: #666;
    }
    img { max-width: 100%; }
    table {
      border-collapse: collapse;
      width: 100%;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 8px;
      text-align: left;
    }
    th { background: #f4f4f4; }
    #content { min-height: 100px; }
    .status {
      position: fixed;
      top: 10px;
      right: 10px;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
    }
    .status.connected { background: #d4edda; color: #155724; }
    .status.disconnected { background: #f8d7da; color: #721c24; }
  </style>
</head>
<body>
  <div class="status disconnected" id="status">Disconnected</div>
  <div id="content"><p><em>Waiting for content...</em></p></div>

  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
  <script>
    marked.use({ breaks: true });
    mermaid.initialize({ startOnLoad: false, theme: 'default' });

    const contentEl = document.getElementById('content');
    const statusEl = document.getElementById('status');

    async function renderContent(markdown) {
      contentEl.innerHTML = marked.parse(markdown);
      // Re-render any mermaid diagrams
      const mermaidEls = contentEl.querySelectorAll('.mermaid');
      if (mermaidEls.length > 0) {
        await mermaid.run({ nodes: mermaidEls });
      }
    }

    function connect() {
      const es = new EventSource('/events');

      es.onopen = () => {
        statusEl.textContent = 'Connected';
        statusEl.className = 'status connected';
      };

      es.addEventListener('update', (e) => {
        const markdown = e.data;
        renderContent(markdown);
      });

      es.onerror = () => {
        statusEl.textContent = 'Disconnected';
        statusEl.className = 'status disconnected';
        es.close();
        // Reconnect after 2 seconds
        setTimeout(connect, 2000);
      };
    }

    connect();
  </script>
</body>
</html>`;

// Send SSE event
function sendSSE(res: ServerResponse, event: string, data: string): void {
  res.write(`event: ${event}\n`);
  // Handle multi-line data per SSE spec
  const lines = data.split("\n");
  for (const line of lines) {
    res.write(`data: ${line}\n`);
  }
  res.write("\n");
}

// Format price with currency symbol
function formatPrice(price: number, currency: string): string {
  const symbols: Record<string, string> = {
    GBP: "£",
    USD: "$",
    EUR: "€",
    JPY: "¥",
    CAD: "C$",
    AUD: "A$",
  };
  const symbol = symbols[currency] || currency + " ";
  return `${symbol}${price.toFixed(2)}`;
}

// Render product as HTML card
function renderProductHTML(product: Product): string {
  const parts: string[] = [];

  parts.push(
    `<div style="max-width: 500px; border: 1px solid #ddd; border-radius: 8px; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">`,
  );

  // Image
  if (product.image_url) {
    parts.push(
      `<img src="${product.image_url}" alt="${product.title}" style="width: 100%; height: auto; display: block;">`,
    );
  }

  parts.push(`<div style="padding: 16px;">`);

  // Title (linked if product_url available)
  if (product.product_url) {
    parts.push(
      `<h2 style="margin: 0 0 8px 0; font-size: 1.25rem;"><a href="${product.product_url}" target="_blank" style="color: #333; text-decoration: none;">${product.title}</a></h2>`,
    );
  } else {
    parts.push(
      `<h2 style="margin: 0 0 8px 0; font-size: 1.25rem;">${product.title}</h2>`,
    );
  }

  // Brand and store
  const brandStore = [product.brand, product.store].filter(Boolean).join(" · ");
  if (brandStore) {
    parts.push(
      `<p style="margin: 0 0 8px 0; color: #666; font-size: 0.9rem;">${brandStore}</p>`,
    );
  }

  // Variant, size, color
  const details = [product.variant, product.size, product.color]
    .filter(Boolean)
    .join(" / ");
  if (details) {
    parts.push(`<p style="margin: 0 0 12px 0; color: #666;">${details}</p>`);
  }

  // Price section
  parts.push(`<div style="margin-bottom: 12px;">`);
  parts.push(
    `<span style="font-size: 1.5rem; font-weight: bold; color: #333;">${formatPrice(product.price, product.currency)}</span>`,
  );

  if (product.compare_at_price) {
    parts.push(
      ` <span style="text-decoration: line-through; color: #999;">${formatPrice(product.compare_at_price, product.currency)}</span>`,
    );
  }

  if (product.discount_percent) {
    parts.push(
      ` <span style="background: #e53935; color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.8rem;">${product.discount_percent.toFixed(0)}% off</span>`,
    );
  }

  if (product.savings) {
    parts.push(
      `<div style="color: #4caf50; font-size: 0.9rem; margin-top: 4px;">Save ${formatPrice(product.savings, product.currency)}</div>`,
    );
  }

  if (product.previous_price) {
    parts.push(
      `<div style="color: #666; font-size: 0.9rem; margin-top: 4px;">Was ${formatPrice(product.previous_price, product.currency)}</div>`,
    );
  }

  parts.push(`</div>`);

  // Availability
  if (product.available !== undefined) {
    if (product.available) {
      parts.push(
        `<span style="background: #4caf50; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.85rem;">In Stock</span>`,
      );
    } else {
      parts.push(
        `<span style="background: #9e9e9e; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.85rem;">Out of Stock</span>`,
      );
    }
  }

  // Event info
  const eventInfo: string[] = [];
  if (product.first_seen_at) {
    eventInfo.push(`Added: ${product.first_seen_at}`);
  }
  if (product.became_available_at) {
    eventInfo.push(`Restocked: ${product.became_available_at}`);
  }
  if (product.event_timestamp) {
    eventInfo.push(`Event: ${product.event_timestamp}`);
  }
  if (eventInfo.length > 0) {
    parts.push(
      `<p style="margin: 12px 0 0 0; color: #666; font-size: 0.8rem;">${eventInfo.join(" · ")}</p>`,
    );
  }

  parts.push(`</div>`); // Close padding div
  parts.push(`</div>`); // Close card div

  return parts.join("\n");
}

// Create HTTP server
const server = http.createServer(
  (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method;
    const url = req.url;

    // GET / - Serve HTML page
    if (method === "GET" && url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(HTML_PAGE);
      return;
    }

    // POST / - Accept markdown content
    if (method === "POST" && url === "/") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk;
      });
      req.on("end", () => {
        currentContent = body;

        // Broadcast to all SSE clients
        for (const client of clients) {
          sendSSE(client, "update", currentContent);
        }

        res.writeHead(204);
        res.end();
      });
      req.on("error", (err: Error) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(err.message);
      });
      return;
    }

    // GET /events - SSE endpoint
    if (method === "GET" && url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      clients.add(res);

      // Send current content immediately if available
      if (currentContent) {
        sendSSE(res, "update", currentContent);
      }

      // Remove client on close
      req.on("close", () => {
        clients.delete(res);
      });
      return;
    }

    // 404 for everything else
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  },
);

// Create MCP server
const mcpServer = new McpServer({
  name: "md-server",
  version: "1.0.0",
});

// Register the display_markdown tool
mcpServer.tool(
  "display_markdown",
  "Render markdown (or HTML) content in the user's browser via a live-updating webpage.",
  {
    markdown: z.string().describe("Markdown or HTML content to display"),
  },
  async ({ markdown }) => {
    currentContent = markdown;

    // Broadcast to all SSE clients
    for (const client of clients) {
      sendSSE(client, "update", currentContent);
    }

    return {
      content: [{ type: "text", text: "Markdown displayed successfully" }],
    };
  },
);

// Register the display_image tool
mcpServer.tool(
  "display_image",
  "Display an image in the browser. Accepts either a URL or base64-encoded image data.",
  {
    url: z.string().optional().describe("URL to the image"),
    base64: z.string().optional().describe("Base64-encoded image data"),
    media_type: z
      .string()
      .optional()
      .describe("MIME type for base64 data (e.g., image/png, image/jpeg)"),
    alt: z.string().optional().describe("Alt text for the image"),
    caption: z.string().optional().describe("Caption to display below image"),
  },
  async ({ url, base64, media_type, alt, caption }) => {
    if (!url && !base64) {
      return {
        content: [
          { type: "text", text: "Error: Either url or base64 is required" },
        ],
        isError: true,
      };
    }

    const altText = alt || "Image";
    let src: string;

    if (base64) {
      const mime = media_type || "image/png";
      src = `data:${mime};base64,${base64}`;
    } else {
      src = url!;
    }

    const parts: string[] = [
      `<div style="text-align: center;">`,
      `<img src="${src}" alt="${altText}" style="max-width: 100%; height: auto; border-radius: 4px;">`,
    ];

    if (caption) {
      parts.push(
        `<p style="margin-top: 8px; color: #666; font-style: italic;">${caption}</p>`,
      );
    }

    parts.push(`</div>`);

    currentContent = parts.join("\n");

    for (const client of clients) {
      sendSSE(client, "update", currentContent);
    }

    return {
      content: [{ type: "text", text: "Image displayed successfully" }],
    };
  },
);

// Register the display_mermaid tool
mcpServer.tool(
  "display_mermaid",
  "Render a Mermaid diagram in the browser. Supports flowcharts, sequence diagrams, class diagrams, and more.",
  {
    diagram: z.string().describe("Mermaid diagram syntax"),
    title: z.string().optional().describe("Optional title above the diagram"),
  },
  async ({ diagram, title }) => {
    const parts: string[] = [];

    if (title) {
      parts.push(
        `<h2 style="text-align: center; margin-bottom: 16px;">${title}</h2>`,
      );
    }

    // Use a unique ID for each render to avoid conflicts
    const diagramId = `mermaid-${Date.now()}`;
    parts.push(`<div style="display: flex; justify-content: center;">`);
    parts.push(`<pre class="mermaid" id="${diagramId}">`);
    parts.push(diagram);
    parts.push(`</pre>`);
    parts.push(`</div>`);

    currentContent = parts.join("\n");

    for (const client of clients) {
      sendSSE(client, "update", currentContent);
    }

    return {
      content: [
        { type: "text", text: "Mermaid diagram displayed successfully" },
      ],
    };
  },
);

// Register the display_product tool
mcpServer.tool(
  "display_product",
  "Display a product card in the browser with image, price, and details.",
  { product: ProductSchema },
  async ({ product }) => {
    currentContent = renderProductHTML(product);

    // Broadcast to all SSE clients
    for (const client of clients) {
      sendSSE(client, "update", currentContent);
    }

    return {
      content: [{ type: "text", text: `Displayed: ${product.title}` }],
    };
  },
);

// Graceful shutdown when MCP connection closes
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  console.error("Shutting down...");

  // Close all SSE client connections (otherwise server.close() waits forever)
  for (const client of clients) {
    client.end();
  }
  clients.clear();

  server.close(() => {
    process.exit(0);
  });
}

// Start HTTP server
server.listen(PORT, async () => {
  console.error(`Listening on http://localhost:${PORT}`);

  // Connect MCP server to stdio transport
  const transport = new StdioServerTransport();

  // StdioServerTransport doesn't detect stdin close, so listen directly
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  await mcpServer.connect(transport);
});
