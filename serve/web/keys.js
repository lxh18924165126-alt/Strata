// Opt-in key administration. The ordinary chat credential is never used here.
"use strict";
(() => {
  const el = id => document.getElementById(`keys-${id}`);
  let admin = "", selected = null, pendingDelete = null, revision = 0, refreshTimer = null, rows = [], models = [], defaultModel = "";
  try { admin = sessionStorage.getItem("strata.keys.admin") || ""; } catch (_) {}
  const states = {active: "启用", disabled: "已停用", deleted: "已删除"};
  const number = n => Number(n || 0).toLocaleString("zh-CN");
  const stamp = t => t ? new Date(t * 1000).toLocaleString("zh-CN", {timeZone: "Asia/Shanghai", hour12: false}) : "尚无调用";
  function message(text = "", error = false) { el("message").textContent = text; el("message").dataset.error = String(error); }
  function credential(value) {
    admin = value;
    try { if (value) sessionStorage.setItem("strata.keys.admin", value); else sessionStorage.removeItem("strata.keys.admin"); } catch (_) {}
  }
  function clearSecret() { el("secret-value").value = ""; el("copy-status").textContent = ""; }
  function logout() {
    ++revision; credential(""); clearTimeout(refreshTimer);
    selected = pendingDelete = null; rows = [];
    el("rows").replaceChildren(); el("daily").replaceChildren(); el("summary").replaceChildren();
    el("detail").hidden = true; el("workspace").hidden = true; el("logout").hidden = true;
    el("login").hidden = false; el("admin").value = "";
    for (const name of ["secret", "confirm"]) if (el(name).open) el(name).close();
    clearSecret(); message("已退出管理，当前标签页的管理凭证已清除。");
    document.dispatchEvent(new Event("strata-admin-session"));
  }
  async function api(path, body) {
    const requestAdmin = admin;
    const response = await fetch(path, {cache: "no-store", headers: {Authorization: `Bearer ${requestAdmin}`,
      ...(body !== undefined ? {"Content-Type": "application/json"} : {})},
      ...(body !== undefined ? {method: "POST", body: JSON.stringify(body)} : {})});
    const data = await response.json();
    if (requestAdmin !== admin) throw new Error("管理会话已结束，请重新登录。");
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) logout();
      throw new Error(data.error?.message || `请求失败（${response.status}）`);
    }
    return data;
  }
  function beijingDate(offset = 0) {
    return new Date(Date.now() + 8 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
  }
  function query() {
    const q = new URLSearchParams();
    const range = el("range").value;
    if (range === "custom") {
      if (!el("from").value || !el("to").value || el("from").value > el("to").value)
        throw new Error("请选择有效的起止日期，开始日期不能晚于结束日期。");
      q.set("from", el("from").value); q.set("to", el("to").value);
    } else if (range !== "all") {
      q.set("from", beijingDate(range === "today" ? 0 : 1 - Number(range))); q.set("to", beijingDate());
    }
    if (el("deleted").checked) q.set("include_deleted", "true");
    return q.toString();
  }
  function cell(tr, text, cls) {
    const td = document.createElement("td"); td.textContent = text; if (cls) td.className = cls; tr.append(td); return td;
  }
  function button(text, action, label) {
    const b = document.createElement("button"); b.type = "button"; b.className = "st-btn st-btn--secondary";
    b.textContent = text; b.setAttribute("aria-label", label || text);
    b.onclick = async () => { b.disabled = true; try { await action(); } catch (e) { message(e.message, true); } finally { b.disabled = false; } };
    return b;
  }
  function render() {
    const sum = rows.reduce((s, row) => { for (const k of Object.keys(s)) s[k] += row.usage[k]; return s; },
      {requests: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0});
    el("summary").replaceChildren();
    for (const [key, label] of [["requests", "请求次数"], ["input_tokens", "输入 Token"], ["output_tokens", "输出 Token"], ["total_tokens", "总 Token"]]) {
      const card = document.createElement("div"); card.className = "st-card";
      const title = document.createElement("span"); title.className = "muted"; title.textContent = label;
      const value = document.createElement("strong"); value.textContent = number(sum[key]); card.append(title, value); el("summary").append(card);
    }
    el("count").textContent = `${rows.length} 个 Key · 当前筛选范围内用量`;
    el("rows").replaceChildren(); el("empty").hidden = rows.length > 0;
    for (const row of rows) {
      const tr = document.createElement("tr"); tr.dataset.keyId = row.id;
      const name = cell(tr, ""); const strong = document.createElement("strong"); strong.textContent = row.name;
      const preview = document.createElement("code"); preview.textContent = row.preview; name.append(strong, preview);
      const status = cell(tr, states[row.state]); status.dataset.state = row.state;
      const modelCell = cell(tr, "");
      const model = document.createElement("select"); model.className = "st-input";
      model.setAttribute("aria-label", `${row.name} 的模型`); model.disabled = row.state === "deleted" || !models.length;
      const choices = [["", `默认（${defaultModel}）`], ...models.map(name => [name, name])];
      if (row.model && !models.includes(row.model)) choices.push([row.model, `${row.model}（不可用）`]);
      for (const [value, label] of choices) { const option = document.createElement("option"); option.value = value; option.textContent = label; model.append(option); }
      model.value = row.model || "";
      model.onchange = async () => {
        model.disabled = true;
        try { await api(`api/keys/${row.id}/model`, {model: model.value || null}); message("模型分配已保存。"); await refresh(false); }
        catch (e) { model.value = row.model || ""; message(e.message, true); }
        finally { model.disabled = false; }
      };
      modelCell.append(model);
      const time = cell(tr, ""); const created = document.createElement("span"); created.textContent = stamp(row.created_at);
      const used = document.createElement("small"); used.textContent = stamp(row.last_used_at); time.append(created, used);
      for (const k of ["requests", "input_tokens", "output_tokens", "total_tokens"]) cell(tr, number(row.usage[k]), "num");
      const actions = cell(tr, "", "keys-actions");
      actions.append(button("用量", async () => { selected = row.id; await detail(); }, `查看 ${row.name} 的用量`));
      if (row.state !== "deleted") {
        actions.append(button(row.state === "active" ? "停用" : "启用", async () => {
          await api(`api/keys/${row.id}/state`, {state: row.state === "active" ? "disabled" : "active"});
          message(row.state === "active" ? "Key 已停用，新的调用将被拒绝。" : "Key 已启用。"); await refresh(false);
        }, `${row.state === "active" ? "停用" : "启用"} ${row.name}`));
        actions.append(button("删除", () => {
          pendingDelete = row.id; el("confirm-text").textContent = `确定删除「${row.name}」？此操作无法撤销。`; el("confirm").showModal();
        }, `删除 ${row.name}`));
      }
      el("rows").append(tr);
    }
  }
  async function detail() {
    if (!selected) return;
    const id = selected, version = revision;
    const result = await api(`api/keys/${id}/usage?${query()}`);
    if (id !== selected || version !== revision || !admin) return;
    el("detail").hidden = false;
    const row = rows.find(r => r.id === id);
    el("detail-title").textContent = `${row?.name || "Key"} · 每日用量`;
    const u = result.usage;
    el("detail-summary").textContent = `当前范围：${number(u.requests)} 次请求，成功 ${number(u.successful)}，失败 ${number(u.failed)}，中断 ${number(u.interrupted)}，进行中 ${number(u.running)}；缓存输入 ${number(u.cached_tokens)} Token。累计 ${number(result.lifetime.requests)} 次请求、${number(result.lifetime.total_tokens)} Token。` +
      (u.incomplete ? ` 有 ${number(u.incomplete)} 条请求正在执行或未完整结算，Token 可能不完整。` : "");
    el("daily").replaceChildren();
    for (const day of result.daily) {
      const tr = document.createElement("tr"); cell(tr, day.date);
      for (const k of ["requests", "successful", "failed", "interrupted", "running", "input_tokens", "cached_tokens", "output_tokens", "total_tokens", "incomplete"]) cell(tr, number(day[k]), "num");
      el("daily").append(tr);
    }
    if (!result.daily.length) { const tr = document.createElement("tr"); cell(tr, "此日期范围内没有调用记录。").colSpan = 11; el("daily").append(tr); }
  }
  async function refresh(clearMessage = true) {
    if (!admin || !health.key_management) return;
    const version = ++revision;
    try {
      const data = await api(`api/keys?${query()}`);
      if (version !== revision || !admin) return;
      rows = data.keys; models = data.models || []; defaultModel = data.default_model || health.model || "当前模型"; el("workspace").hidden = false; el("logout").hidden = false; el("login").hidden = true;
      if (clearMessage) message(); render();
      document.dispatchEvent(new Event("strata-admin-session"));
      if (selected && rows.some(r => r.id === selected)) await detail();
      else { selected = null; el("detail").hidden = true; }
    } catch (e) { message(e.message, true); throw e; }
  }
  function enter() {
    clearTimeout(refreshTimer);
    if (tab !== "keys") return;
    if (!health.service) return; // Wait for /health before deciding whether the feature exists.
    if (!health.key_management) { message("此服务尚未启用 API Key 管理。", true); return; }
    if (!admin) { message(); return; }
    refresh(false).catch(() => {}).finally(() => { refreshTimer = setTimeout(enter, 10000); });
  }
  el("login").onsubmit = async event => {
    event.preventDefault(); credential(el("admin").value.trim()); el("admin").value = "";
    const submit = el("login").querySelector("button"); submit.disabled = true;
    try { await refresh(); enter(); } catch (_) {} finally { submit.disabled = false; }
  };
  el("logout").onclick = logout;
  el("create").onsubmit = async event => {
    event.preventDefault(); const submit = el("create").querySelector("button"); submit.disabled = true;
    try {
      const result = await api("api/keys", {name: el("name").value.trim()});
      el("secret-value").value = result.key; el("copy-status").textContent = ""; el("secret").showModal(); el("name").value = "";
      await refresh();
    } catch (e) { message(e.message, true); } finally { submit.disabled = false; }
  };
  el("secret-close").onclick = () => { clearSecret(); el("secret").close(); }; el("secret").addEventListener("close", clearSecret);
  el("copy").onclick = async () => {
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) await navigator.clipboard.writeText(el("secret-value").value);
      else { el("secret-value").focus(); el("secret-value").select(); if (!document.execCommand("copy")) throw new Error("clipboard"); }
      el("copy-status").textContent = "已复制，请保存在调用应用中。";
    } catch (_) { el("secret-value").focus(); el("secret-value").select(); el("copy-status").textContent = "自动复制不可用，请手动复制选中的密钥。"; }
  };
  el("confirm-cancel").onclick = () => el("confirm").close();
  el("confirm-delete").onclick = async () => {
    if (!pendingDelete) return; el("confirm-delete").disabled = true;
    try { await api(`api/keys/${pendingDelete}/delete`, {}); el("confirm").close(); message("Key 已删除，历史用量已保留。"); await refresh(false); }
    catch (e) { message(e.message, true); el("confirm").close(); } finally { pendingDelete = null; el("confirm-delete").disabled = false; }
  };
  el("range").onchange = () => { el("dates").hidden = el("range").value !== "custom"; refresh().catch(() => {}); };
  for (const name of ["from", "to", "deleted"]) el(name).onchange = () => refresh().catch(() => {});
  el("refresh").onclick = () => refresh().catch(() => {});
  el("detail-close").onclick = () => { selected = null; el("detail").hidden = true; };
  el("from").value = beijingDate(-6); el("to").value = beijingDate();
  window.strataKeyAdmin = {request: api, login: credential, logout, hasCredential: () => Boolean(admin)};
  document.addEventListener("strata-keys-view", enter); document.addEventListener("strata-health", enter); enter();
})();
