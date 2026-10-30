# ⚡ Postwoman

A fast, local REST client. No account, no cloud, no dependencies: one Node file plus a static UI.

```bash
node server.js          # then open http://localhost:7777
# or: npm start      |   PORT=8080 node server.js   |   npm run start:open  (also opens your browser)
```

Needs Node 18+ (developed and tested on Node 22). Your data is saved to `data.json` next to `server.js` (set `STATE_FILE` to put it elsewhere). Starting a second copy on the same port just says "already running" and exits; if another program holds the port you get a clear message instead of a stack trace.

## What's in it

| | |
|---|---|
| **cURL everywhere** | Paste a cURL command (multi-line, quotes, `-u`, `--json`, `-G`, `-k`, `-L`…) anywhere in the app to import it automatically, or use **Import cURL**. **`</> Code`** (next to the request name) shows the current request, variables resolved, as **cURL, JavaScript (fetch), Python (requests) or PowerShell** with one-click copy. |
| **Grouped tabs** | Chrome-style groups: coloured pills, click to collapse, right-click to rename / recolour / ungroup. Drag a tab onto a pill to join it. Closing a tab or group has **Undo**. |
| **Tags + search** | `#tags` on every request. Sidebar has a search box and tag chips; **Ctrl+K** jumps to any request by name, URL, group or `#tag`. |
| **Easy env variables** | Switcher in the top bar. `{{name}}` works in URL, headers, body and auth. The editor has a table mode and a **Bulk / .env** paste mode. Missing variable? The error offers a one-click "Set {{name}}" and resends. Built-ins: `{{$uuid}} {{$timestamp}} {{$timestampMs}} {{$isoTimestamp}} {{$randomInt}}`. A **Globals** set sits under the active environment. |
| **Tests** | Per-request checks that run after every Send, no scripting: **status** (`2xx`, `200`, `200-299, 404`), **response time** (≤ / <), **JSON path** (exists, equals, contains, matches regex, > ≥ < ≤, type…), **header** and **body text**. `{{variables}}` work in paths and values; they run after captures, so a check can use a value captured from the same response. Results show as a ✓/✗ chip in the response bar and a **Tests** tab (with what was actually received). |
| **Group runner** | Click **▶** on a group (or right-click → *Run group…*, or Ctrl+K) to send every request in it, in order, with the active environment. Captures run between requests, so a login can feed the next calls. A request passes when all its Tests pass (with no tests: status below 400). Options: stop at the first failure, delay between requests. Click a row to open that request and its response; **Copy report (JSON)** exports the run. Nothing is sent until you press Run. |
| **Capture** | Settings tab: save a value from the JSON response (e.g. `access_token`) into the active environment after each call. |
| **Latency** | Per request: DNS, TCP, TLS, TTFB (waiting) and download, plus total. **Latency stats** tab: min / avg / p50 / p90 / **p95** / **p99** / max / std-dev, histogram, last-120 chart, status-code breakdown. Use **Run N × concurrency** to collect samples. Every manual Send counts too. |
| **Compare envs** | **⇆ Compare** (next to Send) fires the same request at every selected environment *at the same moment*, for N rounds. You get a side-by-side latency table (time / p50 / p95 / TTFB / size, fastest highlighted, "+X ms (1.8×)" vs fastest) and a field-level JSON diff against a baseline env (changed / added / removed / type), with an **Ignore fields** box for noisy keys like `timestamp, requestId`. Non-JSON bodies get a line diff. Compare runs don't touch Latency stats or captures. |
| **Load test** | **📈 Load** opens a JMeter-style load test for the current request, run by the local Node server (so the browser's ~6-connection limit doesn't apply). **Thread group:** users (1–5000), ramp-up, then either *duration* (hold + optional ramp-down) or *loop count* per user; think time ± random jitter; optional max throughput (req/s); keep-alive per user. **Data:** CSV (first row = variable names, shared and recycled like JMeter's CSV Data Set), plus `{{$vu}}`, `{{$iteration}}` and fresh `{{$uuid}}`/`{{$timestamp}}`/`{{$randomInt}}` on every request. **Assertions:** success status (`200-399`, `2xx`, `201`), body contains, max response time. **Pass/fail (SLA):** p95 / p99 / p99.99 ≤, error rate ≤, throughput ≥ → PASS/FAIL verdict. **Live dashboard** while running (users, req/s, errors, avg … p99.99, Apdex, charts). **Report:** samples, throughput + peak, error %, Apdex, avg / min / median / p75 / p90 / p95 / p99 / **p99.9 / p99.99** / max / std-dev for response time, latency (TTFB) and connect; all-samples (JMeter) or successful-only; charts for users & throughput, response time over time, percentile curve, distribution, response time vs users, codes per second, network KB/s; response-code and error tables; deltas vs the previous run; run history (last 8 per request). **Export:** raw results as JMeter-compatible `.jtl`, Aggregate-report CSV, JSON, standalone HTML report. |
| **Loader** | Send, Compare, benchmark and load-test runs show a spinner with a live elapsed timer in the response area; Cancel / Stop ends them. |
| **JSON tree** | Lazy (fast on big payloads), search, expand / collapse all, click = copy value, **Alt+click = copy JSONPath**. Also Pretty, Raw, HTML/image Preview, Headers, redirect chain. Big bodies stay responsive: Pretty and Raw show 1 MB slices with a **Show next** button (measured in headless Chromium: switching a 20 MB response to Pretty took ~50 s before, ~1 s now). Above 40 MB of text the Tree is skipped. |
| **Import** | Postman collections (v2.x; verified with a v2.1-style file) and environments; folders become groups. |
| **AI agents** | Postwoman is an **MCP server**, so Claude Desktop, Claude Code, GitHub Copilot (VS Code agent mode and Copilot CLI), Cursor, Windsurf, Gemini CLI, Codex and other MCP clients can use it. Agents can list / inspect / send / compare / load-test your saved requests and create, edit or delete them. Their changes appear live in the open UI and merge with your unsaved edits. Click **🤖 AI agents** for copy-paste setup for each tool. Agents without MCP can use plain REST (`/api/tools/*`, OpenAPI at `/openapi.json`). |

## Connect AI agents (MCP)

| Client | How |
|---|---|
| Claude Code | `claude mcp add postwoman -- node /path/to/postwoman/mcp.js` (or `claude mcp add --transport http postwoman http://127.0.0.1:7777/mcp`) |
| Claude Desktop | `claude_desktop_config.json` → `{"mcpServers":{"postwoman":{"command":"node","args":["/path/to/postwoman/mcp.js"]}}}` |
| GitHub Copilot in VS Code | Already set up for this folder via `.vscode/mcp.json`; elsewhere add `{"servers":{"postwoman":{"type":"stdio","command":"node","args":[".../mcp.js"]}}}` |
| Copilot CLI · Cursor · Windsurf · Gemini CLI · Codex | Same command (`node …/mcp.js`) in their MCP config; exact snippets are under **🤖 AI agents** |
| Anything else | MCP over HTTP at `http://127.0.0.1:7777/mcp`, or REST: `POST /api/tools/<tool>` with JSON arguments |

- `mcp.js` is a stdio bridge to the running server. **It starts Postwoman in the background if it isn't running** (`POSTWOMAN_NO_AUTOSTART=1` to disable). For another port set `POSTWOMAN_PORT`.
- **Tools:** `list_requests`, `get_request`, `send_request` (saved or ad-hoc / curl, with environment, `json_path` and body-size limits), `compare_environments`, `run_load_test` (users, ramp-up, duration or iterations, think time, max rps, assertions, SLA → p50…p99.99, Apdex, verdict, timeline), `get_load_test`, `stop_load_test`, `get_latency_stats`, `list_environments`, `set_variable`, `create_request`, `update_request`, `delete_request`. `send_request` on a saved request also evaluates its Tests and returns them as `tests`; `get_request` lists them. (Tests are created in the UI.)
- **Secrets:** values of secret variables and credential headers are masked in everything agents see, but used when sending. Response bodies are returned as-is.
- **Shared state:** agent sends count in Latency stats and run captures (like Send). Agent load tests show up live in the Load test tab and are saved to the request's history.
- Cloud agents (e.g. the Copilot coding agent on github.com, ChatGPT) can't reach it: the server only listens on 127.0.0.1.

## Shortcuts

`Ctrl/⌘+Enter` send · `Ctrl/⌘+K` jump / actions · `Ctrl/⌘+L` focus URL · `Ctrl/⌘+S` save now · `Alt+T` new tab · `Alt+W` close tab · `Alt+1…9` go to tab · `?` shows this list in the app

## How the numbers are measured (so you can trust them)

- Requests are sent by the **local Node server**, not the browser, so there is no CORS and the timings are real socket events.
- Each request uses a **fresh connection** (no keep-alive), so DNS/TCP/TLS are paid every time. That is the cold-start cost; a warm browser or app client will often be faster.
- `n/a` means the phase does not exist (IP literal → no DNS, `http://` → no TLS).
- Percentiles use the **nearest-rank** method on responses that arrived (transport errors are counted separately). With fewer than 100 samples p99 is just the slowest request; the UI says so.
- With redirects, the phases belong to the final hop; Total covers all hops.
- Concurrency 1 gives clean latency. Higher values measure behaviour under load (and include client-side queueing). Only load-test servers you own.

## Load test: how it measures

- Same timing rules as above per request, but each virtual user keeps its own connection alive (turn keep-alive off to pay DNS/TCP/TLS every time). Connect time is 0 on reused connections.
- **Response time** = request start → last byte (JMeter "elapsed"); **Latency** = → first byte, incl. connect (JMeter "Latency"). Failed samples count in the stats like JMeter; switch to *Successful only* to exclude them.
- Final percentiles are **exact** (nearest-rank) up to 1,000,000 samples; beyond that, and for live numbers, a log histogram is used (±0.1%). p99.99 only means something with ≥ 10,000 samples.
- Apdex: satisfied ≤ T, tolerating ≤ 4T, failed samples are frustrated.
- At the planned end no new requests start, but in-flight ones are waited for and counted (so slow requests aren't silently dropped). **Stop** cancels in-flight requests and discards them.
- Throughput = samples ÷ (last end − first start). Per-second charts bucket by completion time.
- **The generator has limits.** The engine runs on Node's single main thread, roughly 1,500–3,000 req/s depending on the machine. The report shows *main-thread busy %* and *event-loop lag*; if they're high you get a warning, because the times then include the generator's own queueing. Fewer users, think time or a throughput cap fix that.
- One load test runs at a time. The server keeps raw samples (for `.jtl`) of the last 3 runs in memory only; summaries are saved with the request.

## Reliability

- State is written atomically (temp file + rename) with owner-only permissions where the OS supports it. A copy of the last good state is kept as `data.json.bak` at every start.
- A `data.json` that can't be parsed is **moved aside** as `data.json.corrupt-<time>` instead of being overwritten, and the app starts empty so you can recover it by hand.
- The server refuses to save anything that isn't a workspace (`{}`, `[]`, `null`…), so a buggy client can't wipe your data.
- Oversized request bodies get a proper `413` reply. Unexpected errors are logged and the server keeps running. `GET /api/health` tells you it's up.

## Tests

```bash
npm test          # 111 tests, ~25 s: parsers, stats, diff, checks, request builder, proxy engine,
                  # security guards, state safety, load engine, MCP/REST tools, stdio bridge, code generators
npm run test:ui   # 12 browser tests; needs  npm i -D playwright && npx playwright install chromium
```

Everything runs against a local fixture server on free ports with a temporary state file; your `data.json` is never touched. The code-generator tests **execute** the generated cURL (bash), JavaScript (Node) and Python snippets against the fixture and compare what arrived byte for byte; they skip a language whose runtime isn't installed.

## Limits (honest list)

- No multipart/form-data or file upload (`-F`, `-T` are skipped with a warning), no HTTP/2, WebSocket, gRPC, or cookie jar.
- The **PowerShell** snippet follows the documented `Invoke-WebRequest` parameters but is **not executed by the tests** (no PowerShell in the test environment). `--open` / `npm run start:open` is tested on Linux (with a stand-in `xdg-open`); the Windows (`cmd /c start`) and macOS (`open`) paths are untested.
- The cURL snippet uses bash/zsh quoting; on Windows use the PowerShell tab or Git Bash.
- Tests are declarative (no scripts); there is no pre-request script.
- JSON numbers beyond 2^53 lose precision in the tree / pretty view (the Raw view is exact).
- "Secret" variables are masked in the UI and to AI agents only; `data.json` stores everything in plain text. Keep it out of git.
- AI agents act with your access: they can call anything this machine can reach (including load tests). Like the rest of the API, `/mcp` has no login; any local process can use it, while browsers on other sites are blocked by the Origin check.
- Responses over 50 MB are truncated; request bodies over 20 MB are rejected.
- The server listens on `127.0.0.1` only and rejects foreign Host/Origin headers (DNS-rebinding protection). It can still reach anything *your machine* can reach, so don't expose the port.
- Tested in headless Chromium. Firefox/Safari should work (plain ES2020 + CSS variables + `color-mix`) but weren't tested.

## Files

```
server.js          proxy + timings + persistence + live sync (zero deps)
load.js            load-test engine: virtual users, histograms, report, .jtl export
agent.js           AI-agent tools: MCP (Streamable HTTP), REST, OpenAPI
mcp.js             MCP stdio bridge for Claude / Copilot / Cursor / … (auto-starts the server)
public/reqspec.js  request building + {{variables}} (shared by UI and agents)
public/checks.js   response Tests (status / time / JSON path / header / body), shared by UI and agents
public/codegen.js  cURL / JavaScript / Python / PowerShell snippets
public/sync.js     merges agent changes with the user's edits
public/index.html  shell        public/style.css  theme (dark/light)
public/curl.js     cURL parse / build        public/stats.js   percentiles, histogram
public/diff.js     JSON / text diff (compare)    public/loadkit.js  load profile, CSV, status rules
public/chart.js    SVG charts with tooltips
public/tree.js     JSON tree                 public/store.js   state, vars, helpers
public/ui-*.js     tabs · request · response · runner · compare · load · env · palette    public/main.js  boot, import/export
test/              node:test suites (npm test) + Playwright browser tests (npm run test:ui)
```

## What changed in this version

Fixed: Compare's environment checkboxes, *Rounds* and *Ignore fields* were being applied to a throw-away copy of the settings, so unchecking an environment snapped back; `{{constructor}}` / `{{toString}}` resolved to `[object Object]` instead of staying unresolved (UI, agents and load engine); Pretty view of a large response froze the page; an oversized request body dropped the connection instead of replying `413`; a corrupt `data.json` could be silently overwritten. Added: Tests, group runner, `</> Code`, `?` shortcut help, atomic/backed-up state, `--open`, `/api/health`, and the test suites.
