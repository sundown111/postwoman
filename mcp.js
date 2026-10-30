#!/usr/bin/env node
// MCP stdio bridge for AI agents (Claude Desktop, Claude Code, GitHub Copilot, Cursor, Gemini CLI, Codex, …).
// Forwards newline-delimited JSON-RPC from stdin to the local Postwoman server's /mcp endpoint and writes replies to stdout.
// Starts Postwoman in the background if it isn't running (set POSTWOMAN_NO_AUTOSTART=1 to disable).
// Port: POSTWOMAN_PORT (default 7777). Logs go to stderr only; stdout carries protocol messages.
'use strict';

const http = require('http');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const PORT = Number(process.env.POSTWOMAN_PORT) || 7777;
const HOST = '127.0.0.1';
const BASE = 'http://' + HOST + ':' + PORT;
const log = (...a) => process.stderr.write('[postwoman-mcp] ' + a.join(' ') + '\n');

let session = null;
let starting = null;

function post(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body, 'utf8');
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': data.length };
    if (session) headers['Mcp-Session-Id'] = session;
    const req = http.request({ host: HOST, port: PORT, path: '/mcp', method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.headers['mcp-session-id']) session = res.headers['mcp-session-id'];
        resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data);
  });
}

function isUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/api/agent/info', timeout: 1500 }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function autostart() {
  if (process.env.POSTWOMAN_NO_AUTOSTART) return Promise.resolve(false);
  if (!starting) {
    starting = (async () => {
      log('Postwoman is not running on ' + BASE + ', starting it…');
      const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        cwd: __dirname, env: Object.assign({}, process.env, { PORT: String(PORT) }), detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.unref();
      for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); if (await isUp()) { log('Postwoman started: ' + BASE); return true; } }
      log('Postwoman did not start within 10 s');
      return false;
    })();
  }
  return starting;
}

async function forward(line) {
  try { return await post(line); }
  catch (e) {
    if (e.code !== 'ECONNREFUSED' || !(await autostart())) throw e;
    return post(line);
  }
}

function errorReply(id, message) {
  return JSON.stringify({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code: -32000, message } });
}

const write = (s) => process.stdout.write(s + '\n');
let pending = 0, closed = false;
const maybeExit = () => { if (closed && pending === 0) process.exit(0); };

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); return; }
  const id = Array.isArray(msg) ? undefined : msg.id;
  const wantsReply = Array.isArray(msg) || (msg && msg.method && msg.id !== undefined);
  try {
    const r = await forward(line);
    if (r.status === 202) return;
    if ((r.status === 200 || r.status === 400) && r.text.trim()) { write(r.text.replace(/\r?\n/g, ' ')); return; }
    if (r.status === 200) return;
    const why = r.status === 404 || r.status === 405
      ? 'The Postwoman server on ' + BASE + ' is an older version without AI-agent support. Restart it (stop `node server.js`, start it again).'
      : r.status === 403 ? 'Postwoman refused the request (HTTP 403). Is something else using port ' + PORT + '?' : 'Postwoman returned HTTP ' + r.status;
    if (wantsReply) write(errorReply(id, why)); else log(why);
  } catch (e) {
    const why = 'Cannot reach Postwoman at ' + BASE + ' (' + (e.code || e.message) + '). Start it with `node server.js` in ' + __dirname + (process.env.POSTWOMAN_PORT ? '' : ', or set POSTWOMAN_PORT if it uses another port') + '.';
    if (wantsReply) write(errorReply(id, why)); else log(why);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  pending++;
  handle(line).finally(() => { pending--; maybeExit(); });
});
rl.on('close', () => { closed = true; maybeExit(); });
