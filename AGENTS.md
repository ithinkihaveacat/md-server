# Agent Guide for md-server

This document provides context for coding agents working on this codebase.

## Project Overview

A TypeScript Node.js project with two CLI tools for displaying markdown in a browser via Server-Sent Events (SSE).

## Directory Structure

```
md-server/
├── src/
│   ├── server.ts      # HTTP server with SSE support
│   └── push.ts        # CLI tool to push content to server
├── dist/              # Compiled JavaScript (generated)
├── test/
│   └── server.test.js # Integration tests
├── package.json
├── tsconfig.json
└── README.md
```

## Key Files

- `src/server.ts` - Main server logic. Handles HTTP routes (`GET /`, `POST /`, `GET /events`) and SSE broadcasting. Contains embedded HTML with inline markdown parser.
- `src/push.ts` - Reads stdin and POSTs to server. Simple HTTP client.
- `test/server.test.js` - Integration tests using Node's built-in test runner. Spawns server processes and tests HTTP endpoints.

## Build & Test Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm test             # Build and run tests
```

## Architecture Notes

- **No external runtime dependencies** - Uses only Node.js built-in modules
- **Markdown rendering** - Done client-side with an embedded inline parser (no CDN)
- **SSE implementation** - Custom, follows SSE spec for multi-line data
- **State** - Server stores only the most recent markdown content in memory

## Common Modifications

### Adding a new HTTP endpoint

Edit `src/server.ts`, add route handling in the `http.createServer` callback before the 404 fallback.

### Changing markdown rendering

The markdown parser is embedded in the `HTML_PAGE` constant in `src/server.ts`. It uses regex-based parsing. For more features, consider replacing with a library like marked.

### Adding persistence

Currently content is in-memory only. To persist, add file or database storage in the `POST /` handler.

## Testing

Tests use Node's built-in test runner (`node:test`). They spawn actual server processes and make HTTP requests. Port numbers 9876 and 9877 are used to avoid conflicts.

To add tests, edit `test/server.test.js`. Use the `request()` helper for HTTP calls and `spawn()` to start server processes.

## Port Configuration

Default port is 8080. Override via:
- CLI flag: `--port 3000`
- Environment variable: `PORT=3000`
