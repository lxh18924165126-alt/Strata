// Exercise the Monitor with two independent requests and refreshes without a browser or GPU.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "web/app.js"), "utf8");
const code = source.slice(source.indexOf("function renderActiveRequests("), source.indexOf("\nfunction facts("));
class Element {
  constructor() { this.children = []; this.dataset = {}; this.style = {}; this.classList = {toggle() {}}; this.attrs = {}; }
  set innerHTML(value) {
    this.html = value;
    if (value.includes('class="st-btn st-btn--secondary active-request"')) {
      this.children = Array.from({length: 7}, () => new Element());
      this.button = new Element();
      this.children[0].children = [this.button];
    }
  }
  get innerHTML() { return this.html; }
  appendChild(row) { row.parent = this; this.children.push(row); }
  remove() { this.parent.children = this.parent.children.filter((row) => row !== this); }
  querySelector(selector) { return selector === "button" ? this.button : null; }
  addEventListener(name, fn) { this[name] = fn; }
  setAttribute(name, value) { this.attrs[name] = value; }
}
const elements = new Map();
const $ = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
const metrics = {}, sparks = {};
const context = {
  $, document: {createElement: () => new Element(), querySelectorAll: () => []},
  fmt: (n, d = 0) => n == null ? "–" : Number(n).toFixed(d),
  kfmt: String, ctxfmt: String, gb: String, esc: String,
  setMetric: (key, value, unit, sub) => { metrics[key] = {value, sub}; },
  spark: (id, values) => { sparks[id] = values; }, imageLive: () => false,
  renderTotals: () => "", modelOp: null, busy: null, reqShowAll: false,
};
vm.createContext(context);
vm.runInContext(`let selectedRequestId = null, lastMetrics = null; ${code}
  function update(m) { lastMetrics = m; render(m); }
  function render(m) { renderMonitor(m.live, {}, {}, m.engine || {}, m.history || {}, m.last || null, [], null, 0); }
`, context);
const active = [
  {id: "a", state: "generating", prompt_tokens: 100, generated: 20, max_tokens: 100, max_context: 1000, tok_s: 5, elapsed_s: 10},
  {id: "b", state: "generating", prompt_tokens: 200, generated: 30, max_tokens: 300, max_context: 2000, tok_s: 7, elapsed_s: 8},
  {id: "c", state: "queued", prompt_tokens: null, generated: null, max_tokens: null, max_context: null, tok_s: null, elapsed_s: 1},
];
const sample = (requests) => ({live: {state: "generating", requests}, engine: {max_context: 4000}, history: {tok_s: [9, 12], prefill_tok_s_mean: [1, 2]}, last: {prompt_tokens: 400, output_tokens: 20, prompt_ms: 1000}});
context.update(sample(active));
let rows = $("active-body").children;
assert.equal(rows[0].button.attrs["aria-pressed"], "true");
assert.equal($("state-request").textContent, "Request a");
assert.equal($("state-detail").textContent, "20 / 100 output token limit · 5.0 tok/s");
assert.equal($("ctx-sub").textContent, "120 / 1000");
assert.equal(metrics.speed.value, "12.0");
assert.equal(metrics.prefill.value, null);
assert.equal(sparks["sp-prefill"].length, 0);
assert.deepEqual(Array.from(sparks["sp-speed"]), [9, 12]);
assert.equal(rows[2].children[4].textContent, "–");
const selectedButton = rows[1].button;
selectedButton.click();
assert.equal($("state-request").textContent, "Request b");
assert.equal($("ctx-sub").textContent, "230 / 2000");
assert.equal($("state-bar").style.width, "10%");
context.update(sample([...active, {...active[0], id: "d", elapsed_s: 0}]));
rows = $("active-body").children;
assert.equal(rows[1].button, selectedButton, "refresh keeps the focused button in the DOM");
assert.equal(rows[1].button.attrs["aria-pressed"], "true", "new arrivals do not steal selection");
context.update(sample([active[0], active[2]]));
assert.equal($("active-body").children[0].button.attrs["aria-pressed"], "true", "next oldest request is selected");
$("active-body").children[1].button.click();
assert.equal($("state-label").textContent, "Queued");
assert.equal($("ctx-pct").textContent, "–");
assert.equal($("ctx-sub").textContent, "Not running");
context.update(sample([]));
assert.equal($("active-empty").hidden, false);
assert.equal($("state-request").textContent, "Last completed request");
assert.equal($("ctx-sub").textContent, "420 / 4000");
assert.equal(metrics.prefill.value, "400");
assert.equal(metrics.speed.value, "0.0");
console.log("ok concurrent Monitor");
