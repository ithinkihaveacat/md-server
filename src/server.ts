#!/usr/bin/env node

import http, { IncomingMessage, ServerResponse } from 'node:http';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Parse command line arguments
const { values } = parseArgs({
  options: {
    port: {
      type: 'string',
      short: 'p',
      default: process.env.PORT || '8080'
    }
  }
});

const PORT = parseInt(values.port!, 10);

// Store current markdown content
let currentContent = '';

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
  <script>
    marked.use({ breaks: true });

    const contentEl = document.getElementById('content');
    const statusEl = document.getElementById('status');

    function connect() {
      const es = new EventSource('/events');

      es.onopen = () => {
        statusEl.textContent = 'Connected';
        statusEl.className = 'status connected';
      };

      es.addEventListener('update', (e) => {
        const markdown = e.data;
        contentEl.innerHTML = marked.parse(markdown);
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
  const lines = data.split('\n');
  for (const line of lines) {
    res.write(`data: ${line}\n`);
  }
  res.write('\n');
}

// Create HTTP server
const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
  const method = req.method;
  const url = req.url;

  // GET / - Serve HTML page
  if (method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML_PAGE);
    return;
  }

  // POST / - Accept markdown content
  if (method === 'POST' && url === '/') {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => {
      currentContent = body;

      // Broadcast to all SSE clients
      for (const client of clients) {
        sendSSE(client, 'update', currentContent);
      }

      res.writeHead(204);
      res.end();
    });
    req.on('error', (err: Error) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(err.message);
    });
    return;
  }

  // GET /events - SSE endpoint
  if (method === 'GET' && url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    clients.add(res);

    // Send current content immediately if available
    if (currentContent) {
      sendSSE(res, 'update', currentContent);
    }

    // Remove client on close
    req.on('close', () => {
      clients.delete(res);
    });
    return;
  }

  // 404 for everything else
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// Create MCP server
const mcpServer = new McpServer({
  name: 'md-server',
  version: '1.0.0'
});

// Register the display_markdown tool
mcpServer.tool(
  'display_markdown',
  'Render markdown (or HTML) content in the user\'s browser via a live-updating webpage.',
  {
    markdown: z.string().describe('Markdown or HTML content to display')
  },
  async ({ markdown }) => {
    currentContent = markdown;

    // Broadcast to all SSE clients
    for (const client of clients) {
      sendSSE(client, 'update', currentContent);
    }

    return {
      content: [{ type: 'text', text: 'Markdown displayed successfully' }]
    };
  }
);

// Start HTTP server
server.listen(PORT, async () => {
  console.error(`Listening on http://localhost:${PORT}`);

  // Connect MCP server to stdio transport
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
});
