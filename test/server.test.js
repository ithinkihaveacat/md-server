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

// Helper to wait for server to be ready
async function waitForServer(port, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await request({ hostname: 'localhost', port, path: '/', method: 'GET' });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error('Server did not start');
}

describe('md-server', () => {
  let serverProcess;
  const testPort = 9876;

  before(async () => {
    serverProcess = spawn('node', [serverPath, '--port', testPort.toString()], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    await waitForServer(testPort);
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
  const testPort = 9878;

  test('exits when stdin closes', async () => {
    const serverProcess = spawn('node', [serverPath, '--port', testPort.toString()], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    await waitForServer(testPort);

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
    const serverProcess = spawn('node', [serverPath, '--port', (testPort + 1).toString()], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    await waitForServer(testPort + 1);

    // Connect an SSE client
    const sseReq = http.request({
      hostname: 'localhost',
      port: testPort + 1,
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
  const testPort = 9880;

  // Helper to send MCP JSON-RPC message
  function sendMcpMessage(proc, message) {
    const json = JSON.stringify(message);
    proc.stdin.write(json + '\n');
  }

  test('displays product card via MCP tool', async () => {
    const serverProcess = spawn('node', [serverPath, '--port', testPort.toString()], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    await waitForServer(testPort);

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
          product: {
            title: 'Test Product',
            price: 49.99,
            currency: 'GBP',
            brand: 'Test Brand',
            available: true,
            discount_percent: 20,
            compare_at_price: 62.49
          }
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
    const serverProcess = spawn('node', [serverPath, '--port', (testPort + 1).toString()], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    await waitForServer(testPort + 1);

    // Connect to SSE
    const productReceived = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: testPort + 1,
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
          product: {
            title: 'Minimal Product',
            price: 25.00,
            currency: 'USD'
          }
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

describe('md-server-post', () => {
  let serverProcess;
  const testPort = 9877;

  before(async () => {
    serverProcess = spawn('node', [serverPath, '--port', testPort.toString()], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    await waitForServer(testPort);
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
