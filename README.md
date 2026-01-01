# md-server

A simple two-component system for displaying markdown content in a browser,
where content is pushed from an external process.

## Components

| Component          | Description                                                                 |
| ------------------ | --------------------------------------------------------------------------- |
| **md-server**      | HTTP server that hosts a web page, accepts content updates via POST and MCP |
| **md-server-post** | CLI tool that reads markdown from stdin and POSTs it to md-server           |

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

Then open <http://localhost:8080> in your browser.

### Push markdown content

```bash
# Push a string
echo "# Hello World" | md-server-post

# Push a file
cat README.md | md-server-post

# Push command output
some-command --help | md-server-post

# Push to a different server
echo "# Hello" | md-server-post --url http://localhost:3000
```

### MCP Integration

The server also supports the Model Context Protocol (MCP) via stdio, allowing AI
agents to display content. Configure your MCP client to run `md-server` and use
any of the available tools:

| Tool               | Description                                           |
| ------------------ | ----------------------------------------------------- |
| `display_markdown` | Render markdown or HTML content                       |
| `display_image`    | Display an image from URL or base64 data              |
| `display_mermaid`  | Render a Mermaid diagram (flowchart, sequence, etc.)  |
| `display_chart`    | Render an interactive chart with tooltips             |
| `display_product`  | Display a product card with image, price, and details |

## How It Works

```
┌─────────────┐   stdin    ┌──────────────────┐   POST /   ┌─────────────┐
│   source    │ ─────────► │  md-server-post  │ ─────────► │  md-server  │
│  (e.g. cat) │            │                  │            │    :8080    │
└─────────────┘            └──────────────────┘            └──────┬──────┘
                                                                  │
┌─────────────┐   stdio    ┌──────────────────┐                   │
│  MCP Client │ ─────────► │  md-server (MCP) │ ──────────────────┤
│  (AI agent) │            │                  │                   │
└─────────────┘            └──────────────────┘                   │
                                                                  │ SSE /events
                                                                  ▼
                                                           ┌─────────────┐
                                                           │   Browser   │
                                                           └─────────────┘
```

1. **md-server** runs an HTTP server with three endpoints:
   - `GET /` - Serves an HTML page with a markdown viewer
   - `POST /` - Accepts raw markdown/HTML text and broadcasts to connected
     clients
   - `GET /events` - SSE endpoint for live updates

2. **md-server** also runs an MCP server on stdio with display tools

3. **md-server-post** reads markdown from stdin and POSTs it to the server

4. The browser connects via SSE and renders markdown/HTML in real-time

## API

### HTTP Endpoints

| Method | Path      | Content-Type        | Description            |
| ------ | --------- | ------------------- | ---------------------- |
| `GET`  | `/`       | `text/html`         | Markdown viewer page   |
| `POST` | `/`       | `text/plain`        | Push markdown content  |
| `GET`  | `/events` | `text/event-stream` | SSE stream for updates |

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

| Option       | Default | Description       |
| ------------ | ------- | ----------------- |
| `-p, --port` | `8080`  | Port to listen on |

Environment variables: `PORT`

### md-server-post

| Option      | Default                 | Description       |
| ----------- | ----------------------- | ----------------- |
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
