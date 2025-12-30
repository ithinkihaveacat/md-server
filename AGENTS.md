# Agent Guide for md-server

This document provides context for coding agents working on this codebase.

## Project Overview

A TypeScript Node.js project with two CLI tools for displaying markdown in a browser via Server-Sent Events (SSE).

## Directory Structure

```
md-server/
├── src/
│   ├── server.ts      # HTTP + MCP server with SSE support
│   └── post.ts        # CLI tool to POST content to server
├── dist/              # Compiled JavaScript (generated)
├── test/
│   └── server.test.js # Integration tests
├── package.json
├── tsconfig.json
└── README.md
```

## Key Files

- `src/server.ts` - Main server logic. Handles HTTP routes (`GET /`, `POST /`, `GET /events`), SSE broadcasting, and MCP server via stdio. Contains embedded HTML that loads marked.js from CDN.
- `src/post.ts` - Reads stdin and POSTs to server. Simple HTTP client.
- `test/server.test.js` - Integration tests using Node's built-in test runner. Spawns server processes and tests HTTP endpoints.

## Build & Test Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm test             # Build and run tests
```

## Architecture Notes

- **Runtime dependencies** - Uses `@modelcontextprotocol/sdk` for MCP support and `zod` for schema validation
- **Markdown rendering** - Done client-side using marked.js loaded from CDN. Supports HTML passthrough.
- **SSE implementation** - Custom, follows SSE spec for multi-line data
- **MCP integration** - Server runs both HTTP and MCP (stdio) transports simultaneously
- **State** - Server stores only the most recent markdown content in memory

## Common Modifications

### Adding a new HTTP endpoint

Edit `src/server.ts`, add route handling in the `http.createServer` callback before the 404 fallback.

### Changing markdown rendering

The HTML page in `src/server.ts` loads marked.js from CDN. To customize rendering, modify the `marked.use()` configuration in the embedded `<script>` tag.

### Adding persistence

Currently content is in-memory only. To persist, add file or database storage in the `POST /` handler.

## Testing

Tests use Node's built-in test runner (`node:test`). They spawn actual server processes and make HTTP requests. Port numbers 9876 and 9877 are used to avoid conflicts.

To add tests, edit `test/server.test.js`. Use the `request()` helper for HTTP calls and `spawn()` to start server processes.

## Port Configuration

Default port is 8080. Override via:

- CLI flag: `--port 3000`
- Environment variable: `PORT=3000`
