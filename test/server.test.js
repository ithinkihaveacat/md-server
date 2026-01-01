import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', 'dist', 'server.js');
const postPath = join(__dirname, '..', 'dist', 'post.js');

// Helper to make HTTP requests
function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Helper to start server on a random available port
// Returns { process, port } once server is ready
function startServer() {
  return new Promise((resolve, reject) => {
    const serverProcess = spawn('node', [serverPath, '--port', '0'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderr = '';
    const timeout = setTimeout(() => {
      serverProcess.kill();
      reject(new Error(`Server did not start. stderr: ${stderr}`));
    }, 5000);

    serverProcess.stderr.on('data', (chunk) => {
      stderr += chunk;
      // Parse port from "Listening on http://localhost:PORT"
      const match = stderr.match(/Listening on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ process: serverProcess, port: parseInt(match[1], 10) });
      }
    });

    serverProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    serverProcess.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Server exited with code ${code}. stderr: ${stderr}`));
      }
    });
  });
}

describe('md-server', () => {
  let serverProcess;
  let testPort;

  before(async () => {
    const server = await startServer();
    serverProcess = server.process;
    testPort = server.port;
  });

  after(() => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });

  test('GET / returns HTML page', async () => {
    const res = await request({
      hostname: 'localhost',
      port: testPort,
      path: '/',
      method: 'GET'
    });

    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /<html/);
    assert.match(res.body, /EventSource/);
  });

  test('POST / accepts markdown and returns 204', async () => {
    const markdown = '# Test Heading\n\nSome content.';
    const res = await request({
      hostname: 'localhost',
      port: testPort,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(markdown)
      }
    }, markdown);

    assert.strictEqual(res.statusCode, 204);
  });

  test('GET /events returns SSE stream with current content', async () => {
    // First POST some content
    const markdown = '# SSE Test';
    await request({
      hostname: 'localhost',
      port: testPort,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(markdown)
      }
    }, markdown);

    // Then connect to SSE
    const sseData = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: testPort,
        path: '/events',
        method: 'GET'
      }, (res) => {
        assert.strictEqual(res.statusCode, 200);
        assert.match(res.headers['content-type'], /text\/event-stream/);

        let data = '';
        res.on('data', chunk => {
          data += chunk;
          // We got the initial content, close connection
          if (data.includes('# SSE Test')) {
            req.destroy();
            resolve(data);
          }
        });
        res.on('error', () => {}); // Ignore error from destroy
      });
      req.on('error', reject);
      req.end();

      // Timeout after 2 seconds
      setTimeout(() => {
        req.destroy();
        reject(new Error('SSE timeout'));
      }, 2000);
    });

    assert.match(sseData, /event: update/);
    assert.match(sseData, /data: # SSE Test/);
  });

  test('GET /unknown returns 404', async () => {
    const res = await request({
      hostname: 'localhost',
      port: testPort,
      path: '/unknown',
      method: 'GET'
    });

    assert.strictEqual(res.statusCode, 404);
  });

  test('SSE broadcasts updates to connected clients', async () => {
    // Connect to SSE first
    const updateReceived = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: testPort,
        path: '/events',
        method: 'GET'
      }, (res) => {
        let data = '';
        let receivedInitial = false;

        res.on('data', chunk => {
          data += chunk;
          // Skip initial content, wait for broadcast update
          if (!receivedInitial && data.includes('\n\n')) {
            receivedInitial = true;
            data = '';
          } else if (receivedInitial && data.includes('Broadcast Test')) {
            req.destroy();
            resolve(data);
          }
        });
        res.on('error', () => {});
      });
      req.on('error', reject);
      req.end();

      setTimeout(() => {
        req.destroy();
        reject(new Error('Broadcast timeout'));
      }, 3000);
    });

    // Wait a bit for SSE connection to establish
    await new Promise(r => setTimeout(r, 100));

    // POST new content
    const markdown = '# Broadcast Test';
    await request({
      hostname: 'localhost',
      port: testPort,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(markdown)
      }
    }, markdown);

    const sseData = await updateReceived;
    assert.match(sseData, /event: update/);
    assert.match(sseData, /data: # Broadcast Test/);
  });
});

describe('md-server graceful shutdown', () => {
  test('exits when stdin closes', async () => {
    const { process: serverProcess, port: testPort } = await startServer();

    // Close stdin to simulate agent disconnecting
    serverProcess.stdin.end();

    // Server should exit within 2 seconds
    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        serverProcess.kill();
        reject(new Error('Server did not exit after stdin closed'));
      }, 2000);

      serverProcess.on('close', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    assert.strictEqual(exitCode, 0);
  });

  test('exits when stdin closes even with active SSE clients', async () => {
    const { process: serverProcess, port: testPort } = await startServer();

    // Connect an SSE client
    const sseReq = http.request({
      hostname: 'localhost',
      port: testPort,
      path: '/events',
      method: 'GET'
    }, () => {});
    sseReq.on('error', () => {}); // Ignore connection reset
    sseReq.end();

    // Give SSE connection time to establish
    await new Promise(r => setTimeout(r, 100));

    // Close stdin to simulate agent disconnecting
    serverProcess.stdin.end();

    // Server should still exit within 2 seconds despite active SSE connection
    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        serverProcess.kill();
        reject(new Error('Server did not exit after stdin closed (with SSE client)'));
      }, 2000);

      serverProcess.on('close', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    assert.strictEqual(exitCode, 0);
  });
});

describe('display_product MCP tool', () => {
  // Helper to send MCP JSON-RPC message
  function sendMcpMessage(proc, message) {
    const json = JSON.stringify(message);
    proc.stdin.write(json + '\n');
  }

  test('displays product card via MCP tool', async () => {
    const { process: serverProcess, port: testPort } = await startServer();

    // Connect to SSE to receive the product card
    const productReceived = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: testPort,
        path: '/events',
        method: 'GET'
      }, (res) => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
          // Wait for complete SSE message (ends with double newline after all data lines)
          // Also check for In Stock to ensure we have the full card
          if (data.includes('Test Product') && data.includes('In Stock') && data.includes('\n\n')) {
            req.destroy();
            resolve(data);
          }
        });
        res.on('error', () => {});
      });
      req.on('error', reject);
      req.end();

      setTimeout(() => {
        req.destroy();
        reject(new Error('Timeout waiting for product card'));
      }, 5000);
    });

    // Wait for SSE connection to establish
    await new Promise(r => setTimeout(r, 100));

    // Send MCP initialize request
    sendMcpMessage(serverProcess, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' }
      }
    });

    // Wait for initialize response
    await new Promise(r => setTimeout(r, 100));

    // Send initialized notification
    sendMcpMessage(serverProcess, {
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    });

    // Wait a bit
    await new Promise(r => setTimeout(r, 100));

    // Call display_product tool
    sendMcpMessage(serverProcess, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'display_product',
        arguments: {
          products: [{
            title: 'Test Product',
            price: 49.99,
            currency: 'GBP',
            brand: 'Test Brand',
            available: true,
            discount_percent: 20,
            compare_at_price: 62.49
          }]
        }
      }
    });

    // Wait for product card to be received via SSE
    const sseData = await productReceived;

    // Verify product card content
    try {
      assert.match(sseData, /Test Product/);
      assert.match(sseData, /£49\.99/);
      assert.match(sseData, /Test Brand/);
      assert.match(sseData, /20% off/);
      assert.match(sseData, /In Stock/);
    } finally {
      serverProcess.kill();
    }
  });

  test('displays minimal product with only required fields', async () => {
    const { process: serverProcess, port: testPort } = await startServer();

    // Connect to SSE
    const productReceived = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: testPort,
        path: '/events',
        method: 'GET'
      }, (res) => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
          if (data.includes('Minimal Product') && data.includes('$25.00')) {
            req.destroy();
            resolve(data);
          }
        });
        res.on('error', () => {});
      });
      req.on('error', reject);
      req.end();

      setTimeout(() => {
        req.destroy();
        reject(new Error('Timeout waiting for minimal product'));
      }, 5000);
    });

    await new Promise(r => setTimeout(r, 100));

    // Initialize MCP
    sendMcpMessage(serverProcess, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' }
      }
    });

    await new Promise(r => setTimeout(r, 100));

    sendMcpMessage(serverProcess, {
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    });

    await new Promise(r => setTimeout(r, 100));

    // Call with minimal required fields only
    sendMcpMessage(serverProcess, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'display_product',
        arguments: {
          products: [{
            title: 'Minimal Product',
            price: 25.00,
            currency: 'USD'
          }]
        }
      }
    });

    const sseData = await productReceived;

    try {
      assert.match(sseData, /Minimal Product/);
      assert.match(sseData, /\$25\.00/);
      // Should NOT contain optional fields
      assert.doesNotMatch(sseData, /In Stock/);
      assert.doesNotMatch(sseData, /Out of Stock/);
    } finally {
      serverProcess.kill();
    }
  });
});

describe('display_image MCP tool', () => {
  function sendMcpMessage(proc, message) {
    const json = JSON.stringify(message);
    proc.stdin.write(json + '\n');
  }

  async function initMcp(serverProcess) {
    sendMcpMessage(serverProcess, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' }
      }
    });
    await new Promise(r => setTimeout(r, 100));
    sendMcpMessage(serverProcess, {
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    });
    await new Promise(r => setTimeout(r, 100));
  }

  test('displays image from URL', async () => {
    const { process: serverProcess, port: testPort } = await startServer();

    const imageReceived = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: testPort,
        path: '/events',
        method: 'GET'
      }, (res) => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
          // Wait for complete SSE message (contains closing div and double newline)
          if (data.includes('example.com/test.png') && data.includes('</div>') && data.includes('\n\n')) {
            req.destroy();
            resolve(data);
          }
        });
        res.on('error', () => {});
      });
      req.on('error', reject);
      req.end();

      setTimeout(() => {
        req.destroy();
        reject(new Error('Timeout waiting for image'));
      }, 5000);
    });

    await new Promise(r => setTimeout(r, 100));
    await initMcp(serverProcess);

    sendMcpMessage(serverProcess, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'display_image',
        arguments: {
          url: 'https://example.com/test.png',
          alt: 'Test Image',
          caption: 'A test caption'
        }
      }
    });

    const sseData = await imageReceived;

    try {
      assert.match(sseData, /example\.com\/test\.png/);
      assert.match(sseData, /alt="Test Image"/);
      assert.match(sseData, /A test caption/);
    } finally {
      serverProcess.kill();
    }
  });

  test('displays base64 image', async () => {
    const { process: serverProcess, port: testPort } = await startServer();

    const imageReceived = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: testPort,
        path: '/events',
        method: 'GET'
      }, (res) => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
          if (data.includes('data:image/png;base64,')) {
            req.destroy();
            resolve(data);
          }
        });
        res.on('error', () => {});
      });
      req.on('error', reject);
      req.end();

      setTimeout(() => {
        req.destroy();
        reject(new Error('Timeout waiting for base64 image'));
      }, 5000);
    });

    await new Promise(r => setTimeout(r, 100));
    await initMcp(serverProcess);

    sendMcpMessage(serverProcess, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'display_image',
        arguments: {
          base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          media_type: 'image/png'
        }
      }
    });

    const sseData = await imageReceived;

    try {
      assert.match(sseData, /data:image\/png;base64,/);
    } finally {
      serverProcess.kill();
    }
  });
});

describe('display_mermaid MCP tool', () => {
  function sendMcpMessage(proc, message) {
    const json = JSON.stringify(message);
    proc.stdin.write(json + '\n');
  }

  async function initMcp(serverProcess) {
    sendMcpMessage(serverProcess, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' }
      }
    });
    await new Promise(r => setTimeout(r, 100));
    sendMcpMessage(serverProcess, {
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    });
    await new Promise(r => setTimeout(r, 100));
  }

  test('displays mermaid flowchart', async () => {
    const { process: serverProcess, port: testPort } = await startServer();

    const diagramReceived = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: testPort,
        path: '/events',
        method: 'GET'
      }, (res) => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
          if (data.includes('class="mermaid"') && data.includes('graph TD')) {
            req.destroy();
            resolve(data);
          }
        });
        res.on('error', () => {});
      });
      req.on('error', reject);
      req.end();

      setTimeout(() => {
        req.destroy();
        reject(new Error('Timeout waiting for mermaid diagram'));
      }, 5000);
    });

    await new Promise(r => setTimeout(r, 100));
    await initMcp(serverProcess);

    sendMcpMessage(serverProcess, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'display_mermaid',
        arguments: {
          diagram: 'graph TD\n    A[Start] --> B[End]',
          title: 'Test Flowchart'
        }
      }
    });

    const sseData = await diagramReceived;

    try {
      assert.match(sseData, /class="mermaid"/);
      assert.match(sseData, /graph TD/);
      assert.match(sseData, /Test Flowchart/);
    } finally {
      serverProcess.kill();
    }
  });

  test('displays mermaid diagram without title', async () => {
    const { process: serverProcess, port: testPort } = await startServer();

    const diagramReceived = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: testPort,
        path: '/events',
        method: 'GET'
      }, (res) => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
          // Wait for complete SSE message (contains closing tags and double newline)
          if (data.includes('sequenceDiagram') && data.includes('</pre>') && data.includes('\n\n')) {
            req.destroy();
            resolve(data);
          }
        });
        res.on('error', () => {});
      });
      req.on('error', reject);
      req.end();

      setTimeout(() => {
        req.destroy();
        reject(new Error('Timeout waiting for sequence diagram'));
      }, 5000);
    });

    await new Promise(r => setTimeout(r, 100));
    await initMcp(serverProcess);

    sendMcpMessage(serverProcess, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'display_mermaid',
        arguments: {
          diagram: 'sequenceDiagram\n    Alice->>Bob: Hello'
        }
      }
    });

    const sseData = await diagramReceived;

    try {
      assert.match(sseData, /sequenceDiagram/);
      assert.match(sseData, /Alice/);
      assert.doesNotMatch(sseData, /<h2/); // No title header
    } finally {
      serverProcess.kill();
    }
  });
});

describe('display_chart MCP tool', () => {
  function sendMcpMessage(proc, message) {
    const json = JSON.stringify(message);
    proc.stdin.write(json + '\n');
  }

  async function initMcp(serverProcess) {
    sendMcpMessage(serverProcess, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' }
      }
    });
    await new Promise(r => setTimeout(r, 100));
    sendMcpMessage(serverProcess, {
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    });
    await new Promise(r => setTimeout(r, 100));
  }

  test('displays chart with annotations', async () => {
    const { process: serverProcess, port: testPort } = await startServer();

    const chartReceived = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: testPort,
        path: '/events',
        method: 'GET'
      }, (res) => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
          if (data.includes('data-chart=') && data.includes('<canvas>')) {
            req.destroy();
            resolve(data);
          }
        });
        res.on('error', () => {});
      });
      req.on('error', reject);
      req.end();

      setTimeout(() => {
        req.destroy();
        reject(new Error('Timeout waiting for chart'));
      }, 5000);
    });

    await new Promise(r => setTimeout(r, 100));
    await initMcp(serverProcess);

    sendMcpMessage(serverProcess, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'display_chart',
        arguments: {
          type: 'line',
          title: 'Price History',
          data: {
            labels: ['2023-01', '2023-02'],
            datasets: [{
              label: 'Price (GBP)',
              data: [140, 110],
              borderColor: 'rgb(75, 192, 192)'
            }]
          },
          annotations: [{
            value: 110,
            label: 'All-Time Low',
            color: 'green',
            style: 'dashed'
          }]
        }
      }
    });

    const sseData = await chartReceived;

    try {
      const match = sseData.match(/data-chart="([^"]+)"/);
      assert.ok(match, 'chart config not found');
      const decoded = decodeURIComponent(match[1]);
      const config = JSON.parse(decoded);
      assert.strictEqual(config.type, 'line');
      assert.strictEqual(config.title, 'Price History');
      assert.deepStrictEqual(config.data.labels, ['2023-01', '2023-02']);
      assert.strictEqual(config.data.datasets[0].label, 'Price (GBP)');
      assert.deepStrictEqual(config.data.datasets[0].data, [140, 110]);
      assert.strictEqual(config.annotations[0].label, 'All-Time Low');
    } finally {
      serverProcess.kill();
    }
  });

  test('displays chart without annotations', async () => {
    const { process: serverProcess, port: testPort } = await startServer();

    const chartReceived = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: testPort,
        path: '/events',
        method: 'GET'
      }, (res) => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
          if (data.includes('data-chart=') && data.includes('<canvas>')) {
            req.destroy();
            resolve(data);
          }
        });
        res.on('error', () => {});
      });
      req.on('error', reject);
      req.end();

      setTimeout(() => {
        req.destroy();
        reject(new Error('Timeout waiting for chart'));
      }, 5000);
    });

    await new Promise(r => setTimeout(r, 100));
    await initMcp(serverProcess);

    sendMcpMessage(serverProcess, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'display_chart',
        arguments: {
          type: 'bar',
          data: {
            labels: ['A', 'B'],
            datasets: [{
              label: 'Counts',
              data: [3, 7],
              backgroundColor: '#4caf50'
            }]
          }
        }
      }
    });

    const sseData = await chartReceived;

    try {
      const match = sseData.match(/data-chart="([^"]+)"/);
      assert.ok(match, 'chart config not found');
      const decoded = decodeURIComponent(match[1]);
      const config = JSON.parse(decoded);
      assert.strictEqual(config.type, 'bar');
      assert.deepStrictEqual(config.data.labels, ['A', 'B']);
      assert.strictEqual(config.annotations, undefined);
    } finally {
      serverProcess.kill();
    }
  });
});

describe('md-server-post', () => {
  let serverProcess;
  let testPort;

  before(async () => {
    const server = await startServer();
    serverProcess = server.process;
    testPort = server.port;
  });

  after(() => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });

  test('posts stdin content to server', async () => {
    const markdown = '# Post Test\n\nContent from post.';

    // Run md-server-post with stdin
    const postProcess = spawn('node', [postPath, '--url', `http://localhost:${testPort}`], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    postProcess.stdin.write(markdown);
    postProcess.stdin.end();

    const exitCode = await new Promise(resolve => {
      postProcess.on('close', resolve);
    });

    assert.strictEqual(exitCode, 0);

    // Verify content was received by connecting to SSE
    const sseData = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: testPort,
        path: '/events',
        method: 'GET'
      }, (res) => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
          // Wait until we have the full content (ends with double newline for SSE)
          if (data.includes('Content from post')) {
            req.destroy();
            resolve(data);
          }
        });
        res.on('error', () => {});
      });
      req.on('error', reject);
      req.end();

      setTimeout(() => {
        req.destroy();
        reject(new Error('SSE timeout'));
      }, 2000);
    });

    assert.match(sseData, /# Post Test/);
    assert.match(sseData, /Content from post/);
  });

  test('exits with error for invalid server URL', async () => {
    const postProcess = spawn('node', [postPath, '--url', 'http://localhost:59999'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    postProcess.stdin.write('test');
    postProcess.stdin.end();

    let stderr = '';
    postProcess.stderr.on('data', chunk => { stderr += chunk; });

    const exitCode = await new Promise(resolve => {
      postProcess.on('close', resolve);
    });

    assert.notStrictEqual(exitCode, 0);
    assert.match(stderr, /Error/);
  });
});
