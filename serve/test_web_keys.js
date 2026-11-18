"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const elements = new Map();
function node(tag) {
  return {
    tag, value: "", dataset: {}, childNodes: [], listeners: {},
    append(...children) { this.childNodes.push(...children); },
    replaceChildren(...children) { this.childNodes = children; },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    showModal() { this.open = true; },
    close() { this.open = false; this.listeners.close?.(); },
    querySelector() { return this.submit ||= {disabled: false}; },
    setCustomValidity(value) { this.validityMessage = value; },
    reportValidity() { this.reported = true; },
  };
}
function element(id) {
  if (!elements.has(id)) elements.set(id, node(id));
  return elements.get(id);
}
const usage = total_tokens => ({requests: 1, input_tokens: total_tokens, output_tokens: 0, total_tokens});
const records = [
  {id: "unlimited", name: "Unlimited", preview: "a", state: "active", expires_at: null, is_expired: false,
    daily_token_limit: null, weekly_token_limit: null, daily_used_tokens: 12, weekly_used_tokens: 45},
  {id: "zero", name: "Zero", preview: "b", state: "active", expires_at: 0, is_expired: true,
    daily_token_limit: 0, weekly_token_limit: 100, daily_used_tokens: 0, weekly_used_tokens: 100},
  {id: "limited", name: "Limited", preview: "c", state: "active", expires_at: 1893456005, is_expired: false,
    daily_token_limit: 100, weekly_token_limit: 500, daily_used_tokens: 60, weekly_used_tokens: 200},
];
const calls = [];
const context = {
  document: {getElementById: element, createElement: node, addEventListener() {}, dispatchEvent() {}},
  window: {}, sessionStorage: {getItem() { return ""; }, setItem() {}, removeItem() {}},
  Event: class {}, tab: "chat", health: {key_management: true, service: true}, URLSearchParams,
  setTimeout, clearTimeout,
  fetch: async (url, options) => {
    calls.push({url, options});
    if (options.method === "POST") {
      const id = url.split("/")[2];
      Object.assign(records.find(row => row.id === id), JSON.parse(options.body));
      return {ok: true, json: async () => ({})};
    }
    const total = url.includes("from=") ? 3 : 60;
    return {ok: true, json: async () => ({keys: records.map(row => ({...row, usage: usage(total)})), models: []})};
  },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, "web/keys.js"), "utf8"), context);
const el = name => element(`keys-${name}`);
const quotaCell = index => el("rows").childNodes[index].childNodes[8];
const quotaButton = index => el("rows").childNodes[index].childNodes[9].childNodes[1];
const submit = () => el("quota-form").onsubmit({preventDefault() {}});
const lastSave = () => calls.filter(call => call.url === "api/keys/limited/quota").at(-1).options.body;
(async () => {
  process.env.TZ = "America/Los_Angeles";
  context.window.strataKeyAdmin.login("admin");
  el("range").value = "all";
  await el("refresh").onclick();
  assert.equal(quotaCell(0).textContent, "永久有效");
  assert.equal(quotaCell(0).childNodes[0].textContent, "每日已用 12 Token · 不限额");
  assert.equal(quotaCell(0).childNodes[1].textContent, "每周已用 45 Token · 不限额");
  assert.match(quotaCell(1).textContent, /1970.*已到期/);
  assert.match(quotaCell(1).childNodes[0].textContent, /上限 0 · 剩余 0 · 已耗尽/);
  assert.match(quotaCell(1).childNodes[1].textContent, /上限 100 · 剩余 0 · 已耗尽/);
  assert.match(quotaCell(2).childNodes[0].textContent, /上限 100 · 剩余 40/);
  assert.match(quotaCell(2).childNodes[1].textContent, /上限 500 · 剩余 300/);
  el("range").value = "today";
  await el("refresh").onclick();
  assert.equal(el("rows").childNodes[2].childNodes[7].textContent, "3");
  assert.match(quotaCell(2).childNodes[0].textContent, /已用 60 Token/);
  await quotaButton(2).onclick();
  assert.equal(el("quota-expires").value, "2030-01-01T08:00:05");
  assert.equal(el("quota-daily").value, 100);
  assert.equal(el("quota-weekly").value, 500);
  el("quota-expires").value = "2030-01-02T01:02:03";
  el("quota-daily").value = "0";
  el("quota-weekly").value = "250";
  await submit();
  assert.equal(lastSave(), '{"expires_at":1893517323,"daily_token_limit":0,"weekly_token_limit":250}');
  assert.match(quotaCell(2).childNodes[0].textContent, /剩余 0 · 已耗尽/);
  await quotaButton(2).onclick();
  assert.equal(el("quota-expires").value, "2030-01-02T01:02:03");
  el("quota-expires").value = "";
  el("quota-daily").value = "";
  el("quota-weekly").value = "";
  await submit();
  assert.equal(lastSave(), '{"expires_at":null,"daily_token_limit":null,"weekly_token_limit":null}');
  assert.equal(quotaCell(2).textContent, "永久有效");
  assert.match(quotaCell(2).childNodes[1].textContent, /不限额/);
  await quotaButton(2).onclick();
  el("quota-daily").value = "-1";
  const before = calls.length;
  await submit();
  assert.equal(calls.length, before);
  assert.equal(el("quota-daily").reported, true);
  console.log("ok key expiry, daily and weekly quota display and saving");
})().catch(error => { console.error(error); process.exitCode = 1; });
