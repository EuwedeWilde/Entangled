// parser_worker.js
//
// Long-lived Node.js worker that exposes the CrochetPARADE parser as a
// line-delimited JSON-over-stdio service. One pattern per request line in,
// one verdict per response line out.
//
// We load parse64.js / simplify64.js ONCE at startup (they're ~250kB of
// pre-existing JS), then stay alive for the lifetime of the Python training
// process — which is the whole point. Spawning a fresh `node` per pattern
// would make PPO unbearably slow (≈40ms startup × millions of envs ≈ never).
//
// Protocol:
//   Request  (one JSON object per line on stdin):
//     {"id": <number>, "pattern": "<crochetparade source>"}
//   Response (one JSON object per line on stdout):
//     {"id": <number>, "ok": true,  "n_stitches": <int>}
//     {"id": <number>, "ok": false, "error": "<first line of message>"}
//
// We also count "stitch nodes" from the parser's json0 output. That count is
// a useful auxiliary reward signal: a granny round of N rounds should produce
// a roughly known stitch count, so the agent can be nudged toward correct
// growth rate.

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const vm = require('vm');

// ---------------------------------------------------------------------------
// Browser-global shims.
//
// parse64.js was written for the browser. Most of it is pure JS, but a few
// helpers touch `window`, `document`, and `alert`. We stub them just enough
// to keep evaluation quiet — parse64 itself wraps `alert` in a feature check
// (typeof globalThis.alert === 'function'), so we set it explicitly.
// ---------------------------------------------------------------------------
globalThis.alert = function (_msg) { /* swallow parser warnings */ };
globalThis.window = globalThis;
globalThis.document = {
  createElement: () => ({
    appendChild: () => {},
    style: {},
    setAttribute: () => {},
    addEventListener: () => {},
  }),
  body: { appendChild: () => {} },
  getElementById: () => null,
};
globalThis.DIM = 2; // 2-D layout flag the parser checks

// Silence parse64's leftover debug logging. It contains uncommented
// console.log / console.groupCollapsed calls that would otherwise interleave
// with our line-delimited protocol on stdout. We keep console.error active
// so genuine worker errors still surface.
const _noop = () => {};
console.log = _noop;
console.info = _noop;
console.warn = _noop;
console.debug = _noop;
console.group = _noop;
console.groupCollapsed = _noop;
console.groupEnd = _noop;
console.dir = _noop;

// ---------------------------------------------------------------------------
// Load the parser. We use vm.runInThisContext rather than require()
// because these files are CrochetPARADE's verbatim browser scripts — they
// declare top-level functions (processText, etc.) that we want hoisted onto
// the global scope. eval() inside a function creates *locals*, not globals,
// so we use the vm module instead.
// ---------------------------------------------------------------------------
const here = __dirname;
const projectRoot = path.resolve(here, '..');
const simplifySrc = fs.readFileSync(path.join(projectRoot, 'simplify64.js'), 'utf8');
const parseSrc = fs.readFileSync(path.join(projectRoot, 'parse64.js'), 'utf8');
vm.runInThisContext(simplifySrc, { filename: 'simplify64.js' });
vm.runInThisContext(parseSrc, { filename: 'parse64.js' });

if (typeof processText !== 'function') {
  process.stderr.write('parser_worker: processText is not defined after loading parse64.js\n');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Pattern validation.
//
// processText() returns [json0, dotSimple] on success, throws on failure.
// json0 is a JSON-array string of parsed stitch nodes; counting the array
// length gives the stitch count we want for reward shaping.
// ---------------------------------------------------------------------------
function evaluatePattern(pattern) {
  try {
    const result = processText(pattern, '');
    if (!Array.isArray(result) || result.length < 2) {
      return { ok: false, error: 'parser returned no result' };
    }
    const json0 = result[0];
    let nStitches = 0;
    try {
      const parsed = JSON.parse(json0);
      // json0 is {"dimen": ..., "elements": [ {type:'node'|'edge', ...}, ... ]}.
      // We count only "node" entries — those are stitches/chains, not
      // connectivity edges between them.
      if (parsed && Array.isArray(parsed.elements)) {
        nStitches = parsed.elements.filter(e => e && e.type === 'node').length;
      } else if (Array.isArray(parsed)) {
        nStitches = parsed.length;
      }
    } catch (_) {
      // Successful parse, but couldn't count — that's fine, just leave 0.
    }
    return { ok: true, n_stitches: nStitches };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    const firstLine = msg.split('\n', 1)[0].slice(0, 200);
    return { ok: false, error: firstLine };
  }
}

// ---------------------------------------------------------------------------
// Stdin/stdout loop. Line-delimited JSON in both directions.
// ---------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch (_) {
    process.stdout.write(JSON.stringify({ id: null, ok: false, error: 'bad-json' }) + '\n');
    return;
  }
  const id = req.id != null ? req.id : null;
  const pattern = typeof req.pattern === 'string' ? req.pattern : '';
  const verdict = evaluatePattern(pattern);
  process.stdout.write(JSON.stringify({ id, ...verdict }) + '\n');
});

rl.on('close', () => {
  process.exit(0);
});

// Signal readiness so the Python parent can wait before sending requests.
process.stdout.write(JSON.stringify({ id: 'ready', ok: true }) + '\n');
