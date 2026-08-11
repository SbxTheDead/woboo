// MCP (Model Context Protocol) client.
//
// Woboo connects to MCP servers over stdio or HTTP. Each server exposes tools
// that the brain can call during planning and execution. This lets Woboo talk
// to databases, search engines, file systems, GitHub — anything with an MCP
// server — without hard-coding each integration.
//
// Configuration lives in ~/.woboo/mcp.json:
// {
//   "servers": {
//     "filesystem": { "command": "npx", "args": ["@modelcontextprotocol/server-filesystem", "/path"] },
//     "github": { "command": "npx", "args": ["@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } },
//     "memory": { "command": "npx", "args": ["@modelcontextprotocol/server-memory"] },
//     "sqlite": { "command": "npx", "args": ["@modelcontextprotocol/server-sqlite", "db.sqlite"] }
//   }
// }

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureHome } from './config.mjs';
import { record } from './journal.mjs';
import { publish } from './bus.mjs';

const MCP_CONFIG = () => path.join(PATHS.home, 'mcp.json');

const connections = new Map();

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(MCP_CONFIG(), 'utf8'));
  } catch {
    return { servers: {} };
  }
}

export function saveConfig(config) {
  ensureHome();
  fs.writeFileSync(MCP_CONFIG(), JSON.stringify(config, null, 2) + '\n');
}

export function addServer(name, command, args, env) {
  const config = loadConfig();
  config.servers[name] = { command, args: args || [], env: env || {} };
  saveConfig(config);
  record('mcp', 'added server: ' + name, { level: 'ok' });
  return config;
}

export function removeServer(name) {
  const config = loadConfig();
  delete config.servers[name];
  saveConfig(config);
  disconnect(name);
  record('mcp', 'removed server: ' + name, { level: 'info' });
  return config;
}

export function listServers() {
  return Object.entries(loadConfig().servers).map(([name, cfg]) => ({
    name,
    command: cfg.command,
    args: cfg.args || [],
    connected: connections.has(name),
  }));
}

// Connect to an MCP server over stdio. Sends JSON-RPC messages.
export async function connect(name) {
  const config = loadConfig();
  const server = config.servers[name];
  if (!server) throw new Error('unknown MCP server: ' + name);
  if (connections.has(name)) return connections.get(name);

  const child = spawn(server.command, server.args || [], {
    env: { ...process.env, ...(server.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  const conn = { child, tools: [], pending: new Map(), nextId: 1 };

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && conn.pending.has(msg.id)) {
          conn.pending.get(msg.id)(msg);
          conn.pending.delete(msg.id);
        }
      } catch {
        // Malformed line — skip.
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    record('mcp', name + ' stderr: ' + chunk.toString().slice(0, 200), { level: 'warn' });
  });

  child.on('exit', (code) => {
    record('mcp', name + ' exited with code ' + code, { level: code ? 'error' : 'info' });
    connections.delete(name);
  });

  // Send initialize
  await send(conn, { jsonrpc: '2.0', id: conn.nextId++, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'woboo', version: '0.3.0' } } });

  // List tools
  const toolsResp = await send(conn, { jsonrpc: '2.0', id: conn.nextId++, method: 'tools/list', params: {} });
  conn.tools = (toolsResp.result?.tools || []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

  connections.set(name, conn);
  record('mcp', 'connected: ' + name + ' (' + conn.tools.length + ' tools)', { level: 'ok' });
  publish({ type: 'mcp', event: 'connected', server: name, tools: conn.tools.length });
  return conn;
}

export function disconnect(name) {
  const conn = connections.get(name);
  if (conn) {
    conn.child.kill();
    connections.delete(name);
  }
}

export function disconnectAll() {
  for (const [name] of connections) disconnect(name);
}

async function send(conn, msg) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      conn.pending.delete(msg.id);
      reject(new Error('MCP request timed out'));
    }, 30000);
    conn.pending.set(msg.id, (resp) => { clearTimeout(timeout); resolve(resp); });
    conn.child.stdin.write(JSON.stringify(msg) + '\n');
  });
}

// Call a tool on a connected MCP server.
export async function callTool(serverName, toolName, args) {
  const conn = connections.get(serverName);
  if (!conn) throw new Error('MCP server not connected: ' + serverName);
  const resp = await send(conn, {
    jsonrpc: '2.0',
    id: conn.nextId++,
    method: 'tools/call',
    params: { name: toolName, arguments: args || {} },
  });
  return resp.result;
}

// Connect to all configured servers.
export async function connectAll() {
  const config = loadConfig();
  const names = Object.keys(config.servers || {});
  const results = {};
  for (const name of names) {
    try {
      await connect(name);
      results[name] = 'ok';
    } catch (err) {
      results[name] = err.message;
      record('mcp', 'failed to connect ' + name + ': ' + err.message, { level: 'error' });
    }
  }
  return results;
}

// List all tools across all connected servers.
export function allTools() {
  const tools = [];
  for (const [serverName, conn] of connections) {
    for (const tool of conn.tools) {
      tools.push({ server: serverName, ...tool });
    }
  }
  return tools;
}
