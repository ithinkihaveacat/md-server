# md-server

A simple two-component system for displaying markdown content in a browser, where content is pushed from an external process.

## Components

| Component | Description |
|-----------|-------------|
| **md-server** | HTTP server that hosts a web page and accepts content updates via SSE |
| **md-server-push** | CLI tool that reads markdown from stdin and pushes it to md-server |

## Installation

```bash
npm install
npm run build
```

For global installation:

```bash
npm install -g .
```

## Usage

### Start the server

```bash
# Default port 8080
md-server

# Custom port
md-server --port 3000

# Or via environment variable
PORT=3000 md-server
```

Then open http://localhost:8080 in your browser.

### Push markdown content

```bash
# Push a string
echo "# Hello World" | md-server-push

# Push a file
cat README.md | md-server-push

# Push command output
some-command --help | md-server-push

# Push to a different server
echo "# Hello" | md-server-push --url http://localhost:3000
```

## How It Works

```
┌─────────────┐   stdin    ┌──────────────────┐   POST /   ┌─────────────┐
│   source    │ ─────────► │  md-server-push  │ ─────────► │  md-server  │
│  (e.g. cat) │            │                  │            │    :8080    │
└─────────────┘            └──────────────────┘            └──────┬──────┘
                                                                  │
                                                                  │ SSE /events
                                                                  ▼
                                                           ┌─────────────┐
                                                           │   Browser   │
                                                           └─────────────┘
```

1. **md-server** runs an HTTP server with three endpoints:
   - `GET /` - Serves an HTML page with a markdown viewer
   - `POST /` - Accepts raw markdown text and broadcasts to connected clients
   - `GET /events` - SSE endpoint for live updates

2. **md-server-push** reads markdown from stdin and POSTs it to the server

3. The browser connects via SSE and renders markdown as HTML in real-time

## API

### HTTP Endpoints

| Method | Path | Content-Type | Description |
|--------|------|--------------|-------------|
| `GET` | `/` | `text/html` | Markdown viewer page |
| `POST` | `/` | `text/plain` | Push markdown content |
| `GET` | `/events` | `text/event-stream` | SSE stream for updates |

### SSE Events

The server broadcasts `update` events with markdown content:

```
event: update
data: # Hello World
data:
data: This is markdown content.

```

## CLI Options

### md-server

| Option | Default | Description |
|--------|---------|-------------|
| `-p, --port` | `8080` | Port to listen on |

Environment variables: `PORT`

### md-server-push

| Option | Default | Description |
|--------|---------|-------------|
| `-u, --url` | `http://localhost:8080` | Target server URL |

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run tests
npm test
```

## License

MIT
