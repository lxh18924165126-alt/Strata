// Date boundaries, sparse chart buckets and CSV safety without a browser or GPU.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "web/usage.js"), "utf8");
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    value: "", dataset: {}, style: {}, childNodes: [], hidden: false,
    addEventListener() {},
    append(...children) { this.childNodes.push(...children); },
    replaceChildren(...children) { this.childNodes = children; },
    setAttribute(name, value) { this[name] = value; },
  });
  return elements.get(id);
}
function node(tag) {
  return {
    tag, childNodes: [], style: {},
    append(...children) { this.childNodes.push(...children); },
    replaceChildren(...children) { this.childNodes = children; },
    setAttribute(name, value) { this[name] = value; },
  };
}
let clock = Date.parse("2026-11-08T20:00:00Z");
class FixedDate extends Date { static now() { return clock; } }
const context = {
  window: {strataKeyAdmin: {}, addEventListener() {}, innerWidth: 800, innerHeight: 600},
  document: {getElementById: element, createElement: node, createTextNode: textContent => ({textContent}), addEventListener() {}},
  Option: class { constructor(text, value) { this.text = text; this.value = value; } },
  tab: "monitor", health: {key_management: true},
  Date: FixedDate, URLSearchParams,
  esc: s => String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c])),
};
vm.createContext(context);
vm.runInContext(source.replace(/  enter\(\);\s*\}\)\(\);\s*$/, "  globalThis.testUsage = {range, buckets, chart, csvCell, showTooltip, hideTooltip, render, query};\n})();"), context);
const {range, buckets, chart, csvCell, showTooltip, hideTooltip, render, query} = context.testUsage;
const dates = () => JSON.parse(JSON.stringify(range()));
element("usage-zone").value = "Asia/Shanghai";
element("usage-range").value = "today";
assert.deepEqual(dates(), {from: "2026-11-09", to: "2026-11-09", interval: "hour"});
element("usage-zone").value = "UTC";
assert.deepEqual(dates(), {from: "2026-11-08", to: "2026-11-08", interval: "hour"});
element("usage-range").value = "yesterday";
assert.deepEqual(dates(), {from: "2026-11-07", to: "2026-11-07", interval: "hour"});
element("usage-range").value = "30";
assert.deepEqual(dates(), {from: "2026-10-10", to: "2026-11-08", interval: "day"});
element("usage-range").value = "month";
assert.deepEqual(dates(), {from: "2026-11-01", to: "2026-11-08", interval: "day"});
clock = Date.parse("2024-03-01T12:00:00Z");
element("usage-range").value = "last-month";
assert.deepEqual(dates(), {from: "2024-02-01", to: "2024-02-29", interval: "day"});
element("usage-range").value = "custom";
element("usage-from").value = "2026-11-10";
element("usage-to").value = "2026-11-08";
assert.throws(range, /起止日期/);
element("usage-from").value = "";
assert.throws(range, /起止日期/);
element("usage-range").value = "custom";
element("usage-from").value = "2026-11-01";
element("usage-to").value = "2026-11-03";
element("usage-zone").value = "UTC";
element("usage-key").value = "selected-key";
assert.deepEqual(JSON.parse(JSON.stringify(Object.fromEntries(query()))), {
  from: "2026-11-01", to: "2026-11-03", interval: "day", timezone: "UTC", group: "key", key_id: "selected-key",
});
const times = buckets({from: "2026-11-01", to: "2026-11-03", interval: "day"});
assert.equal(times.join(","), "2026-11-01,2026-11-02,2026-11-03");
const hours = buckets({from: "2026-11-08", to: "2026-11-08", interval: "hour"});
assert.equal(hours.length, 24);
assert.equal(hours[0], "2026-11-08 00:00");
assert.equal(hours[23], "2026-11-08 23:00");
const empty = chart(times, [], "total_tokens");
assert.match(empty, /暂无用量/);
assert.doesNotMatch(empty, /NaN|Infinity|undefined/);
const graph = chart(times, [{name: '<script>alert("key")</script>', series: [{time: times[1], total_tokens: 12}]}], "total_tokens");
assert.match(graph, /&lt;script&gt;/);
assert.match(graph, /2026-11-02/);
assert.doesNotMatch(graph, /<script>|NaN|Infinity/);
assert.doesNotMatch(graph, /<title>/, "custom tooltips must not compete with the delayed native tooltip");
const tooltipData = svg => Array.from(svg.matchAll(/data-usage="([^"]+)"/g), match => JSON.parse(match[1]
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")));
const daily = tooltipData(graph);
assert.equal(daily.length, 3);
assert.equal(daily[1].time, "2026-11-02");
assert.equal(daily[1].total, 12);
assert.equal(daily[1].items[0].value, 12);
assert.equal(daily[0].items[0].value, 0, "request and token detail charts include zero-value buckets");
const overview = tooltipData(chart(times, [{name: "key", series: []}], "total_tokens", false, "Tokens", 900, false));
assert.equal(overview[0].items.length, 0, "overview omits inactive keys for the hovered date");
const tooltip = element("usage-tooltip");
tooltip.style = {};
tooltip.getBoundingClientRect = () => ({width: 300, height: 150});
const classes = new Set();
const hit = {dataset: {usage: JSON.stringify(daily[1])}, classList: {add: value => classes.add(value), remove: value => classes.delete(value)}};
showTooltip({target: {closest: () => hit}, clientX: 790, clientY: 590});
assert.equal(tooltip.hidden, false);
assert.equal(classes.has("is-hovered"), true);
assert.match(tooltip.innerHTML, /2026-11-02/);
assert.match(tooltip.innerHTML, /&lt;script&gt;/);
assert.doesNotMatch(tooltip.innerHTML, /<script>/);
assert.equal(tooltip.style.left, "474px");
assert.equal(tooltip.style.top, "424px");
showTooltip({target: {closest: () => hit}, clientX: 20, clientY: 20});
assert.equal(tooltip.style.left, "36px", "tooltip follows the pointer within the same date bucket");
showTooltip({target: {closest: () => null}});
assert.equal(tooltip.hidden, true);
assert.equal(classes.has("is-hovered"), false);
hideTooltip();
assert.equal(csvCell('A,"B"'), '"A,""B"""');
assert.equal(csvCell("=SUM(A1:A2)"), '"\'=SUM(A1:A2)"');
assert.equal(csvCell("-cmd"), '"\'-cmd"');
assert.equal(csvCell("办公电脑"), '"办公电脑"');

const zeroUsage = {requests: 0, successful: 0, failed: 0, interrupted: 0, running: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, total_tokens: 0, incomplete: 0};
const modelGroups = [
  {id: "deepseek41", name: "DeepSeek V4.1-Flash", usage: {...zeroUsage, requests: 2, input_tokens: 20, cached_tokens: 5, output_tokens: 8, total_tokens: 28}, series: [{time: "2026-11-02", requests: 2, input_tokens: 20, cached_tokens: 5, output_tokens: 8, total_tokens: 28}]},
  {id: "qwen", name: "Qwen3.8-Flash-Next", usage: {...zeroUsage}, series: []},
  {id: null, name: "历史记录（模型未记录）", usage: {...zeroUsage, requests: 1}, series: [{time: "2026-11-03", requests: 1, input_tokens: 0, cached_tokens: 0, output_tokens: 0, total_tokens: 0}]},
];
const emptyKey = {id: "selected-key", name: "Selected API key", preview: "abcd", state: "active", usage: {...zeroUsage}};
function renderModelGroups(group, groups) {
  render({
    group, groups, model_groups: modelGroups, keys: [emptyKey], key_id: "selected-key",
    usage: {...zeroUsage, requests: 2, total_tokens: 28}, lifetime: {total_tokens: 28},
    from: "2026-11-01", to: "2026-11-03", timezone: "UTC", interval: "day",
  });
  return element("usage-groups").childNodes.map(section => ({
    name: section.childNodes[0].textContent,
    cards: section.childNodes[1].childNodes.map(card => ({title: card.childNodes[0].textContent, chart: card.childNodes[1].innerHTML})),
  }));
}
const modelCardsByKey = renderModelGroups("key", [{id: "selected-key", name: "Selected API key", usage: {...zeroUsage, total_tokens: 28}, series: []}]);
assert.deepEqual(modelCardsByKey.map(section => section.name), ["DeepSeek V4.1-Flash", "Qwen3.8-Flash-Next", "历史记录（模型未记录）"]);
assert.equal(modelCardsByKey[1].cards.length, 2, "zero-usage available models still get both charts");
assert.match(modelCardsByKey[1].cards[0].chart, /暂无用量/);
assert.match(modelCardsByKey[1].cards[1].chart, /暂无用量/);
const modelCardsByPath = renderModelGroups("path", [{id: "/v1/chat/completions", name: "调用类型", usage: {...zeroUsage, total_tokens: 28}, series: []}]);
assert.deepEqual(modelCardsByPath.map(section => section.name), modelCardsByKey.map(section => section.name), "top-level API key/path grouping does not change model charts");
const keyVisibilityData = {
  group: "key", groups: [], model_groups: modelGroups,
  keys: [emptyKey, {...emptyKey, id: "disabled-key", name: "Disabled key", state: "disabled"},
    {...emptyKey, id: "deleted-key", name: "Deleted key", state: "deleted", usage: {...zeroUsage, requests: 7}}],
  key_id: null, usage: {...zeroUsage}, lifetime: {total_tokens: 0},
  from: "2026-11-01", to: "2026-11-03", timezone: "UTC", interval: "day",
};
element("usage-key").value = "disabled-key";
render(keyVisibilityData);
assert.deepEqual(element("usage-key").childNodes.map(option => option.value), ["", "selected-key", "disabled-key"], "only current keys appear in the selector, including disabled keys");
assert.deepEqual(element("usage-key").childNodes.map(option => option.text), ["全部", "Selected API key", "Disabled key"], "key options display names only");
assert.equal(element("usage-key").value, "disabled-key", "refresh preserves a current disabled key selection");
const displayedNames = () => element("usage-rows").childNodes.map(row => row.childNodes[0].childNodes[0].textContent);
assert.deepEqual(displayedNames(), ["Selected API key", "Disabled key"], "deleted keys stay out of the table even with historical usage; current zero-usage keys remain visible");
assert.equal(element("usage-rows").childNodes[0].childNodes[0].childNodes.length, 1, "key name cells do not append a credential preview");
render({...keyVisibilityData, key_id: "disabled-key"});
assert.deepEqual(displayedNames(), ["Disabled key"], "per-key table filtering still applies");
element("usage-key").value = "deleted-key";
render(keyVisibilityData);
assert.equal(element("usage-key").value, "", "a deleted key cannot remain selected");
render({...keyVisibilityData, groups: [{...emptyKey, series: [{time: "2026-11-02", total_tokens: 7}]}]});
assert.equal(tooltipData(element("usage-trend-chart").innerHTML)[1].items[0].name, emptyKey.name, "overview tooltips display key names only");
assert.doesNotMatch(element("usage-trend-chart").innerHTML, /abcd/, "credential previews are not embedded in the tooltip");
console.log("ok usage dates, chart tooltip values, pointer tracking, edge placement and safe CSV");
