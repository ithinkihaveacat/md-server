#!/usr/bin/env node

import http from "node:http";
import https from "node:https";
import { parseArgs } from "node:util";

// Parse command line arguments
const { values } = parseArgs({
  options: {
    url: {
      type: "string",
      short: "u",
      default: "http://localhost:8080",
    },
  },
});

const targetUrl = new URL(values.url!);

// Read all stdin into memory
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// POST content to server
function postContent(content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = targetUrl.protocol === "https:" ? https : http;

    const req = protocol.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        path: "/",
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": Buffer.byteLength(content),
        },
      },
      (res) => {
        if (res.statusCode === 204) {
          resolve();
        } else {
          let body = "";
          res.on("data", (chunk: Buffer) => {
            body += chunk;
          });
          res.on("end", () => {
            reject(new Error(`Server returned ${res.statusCode}: ${body}`));
          });
        }
      },
    );

    req.on("error", reject);
    req.write(content);
    req.end();
  });
}

// Main
async function main(): Promise<void> {
  try {
    const content = await readStdin();
    await postContent(content);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
