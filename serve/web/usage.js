// Durable API usage; shares the existing administrator session with API Keys.
"use strict";
(() => {
  const el = id => document.getElementById(`usage-${id}`);
  const admin = window.strataKeyAdmin;
  const number = n => Number(n).toLocaleString("zh-CN");
  const colors = ["#3b82f6", "#4634e8", "#783ce9", "#34b1d6", "#4677db", "#15aabf", "#a88aef", "#6aa8ff"];
  const states = {active: "启用", disabled: "已停用", deleted: "已删除"};
  const fields = ["requests", "successful", "failed", "interrupted", "running", "input_tokens", "cached_tokens", "output_tokens", "total_tokens", "incomplete"];
  let group = "key", result = null, revision = 0, timer = null;
  let hovered = null, hoverPosition = null;

  function hideTooltip() {
    if (hovered) hovered.classList.remove("is-hovered");
    hovered = null; hoverPosition = null; el("tooltip").hidden = true;
  }
  function showTooltip(event) {
    const hit = event.target.closest(".usage-hit");
    if (!hit) { hideTooltip(); return; }
    const tooltip = el("tooltip");
    if (hit !== hovered) {
      hideTooltip(); hovered = hit; hit.classList.add("is-hovered");
      const data = JSON.parse(hit.dataset.usage);
      tooltip.innerHTML = `<div class="usage-tooltip-heading"><strong>${esc(data.time)}</strong><strong>${number(data.total)}</strong></div>` +
        data.items.map(item => `<div class="usage-tooltip-row"><i style="background:${item.color}"></i><span>${esc(item.name)}</span><b>${number(item.value)}</b></div>`).join("");
      tooltip.hidden = false;
    }
    hoverPosition = {clientX: event.clientX, clientY: event.clientY};
    const box = tooltip.getBoundingClientRect(), gap = 16, edge = 12;
    const left = event.clientX + gap + box.width > window.innerWidth - edge ? event.clientX - gap - box.width : event.clientX + gap;
    const top = event.clientY + gap + box.height > window.innerHeight - edge ? event.clientY - gap - box.height : event.clientY + gap;
    tooltip.style.left = `${Math.max(edge, Math.min(left, window.innerWidth - box.width - edge))}px`;
    tooltip.style.top = `${Math.max(edge, Math.min(top, window.innerHeight - box.height - edge))}px`;
  }

  function message(text = "", error = false) { el("message").textContent = text; el("message").dataset.error = String(error); }
  function day(offset = 0) {
    return new Date(Date.now() + (el("zone").value === "UTC" ? 0 : 8 * 3600000) + offset * 86400000).toISOString().slice(0, 10);
  }
  function range() {
    const preset = el("range").value, today = day();
    let from = today, to = today;
    if (preset === "custom") { from = el("from").value; to = el("to").value; }
    else if (preset === "yesterday") from = to = day(-1);
    else if (preset === "month") from = today.slice(0, 8) + "01";
    else if (preset === "last-month") {
      to = new Date(Date.parse(today.slice(0, 8) + "01T00:00:00Z") - 86400000).toISOString().slice(0, 10);
      from = to.slice(0, 8) + "01";
    } else if (preset === "7" || preset === "30") from = day(1 - Number(preset));
    if (!from || !to || from > to) throw new Error("请选择有效的起止日期，开始日期不能晚于结束日期。");
    return {from, to, interval: from === to ? "hour" : "day"};
  }
  function query() {
    return new URLSearchParams({...range(), timezone: el("zone").value, group, ...(el("key").value ? {key_id: el("key").value} : {})});
  }
  function buckets(data) {
    const step = data.interval === "hour" ? 3600000 : 86400000;
    const end = Date.parse(data.to + "T00:00:00Z") + 86400000, times = [];
    for (let at = Date.parse(data.from + "T00:00:00Z"); at < end; at += step) {
      const iso = new Date(at).toISOString();
      times.push(data.interval === "hour" ? iso.slice(0, 13).replace("T", " ") + ":00" : iso.slice(0, 10));
    }
    return times;
  }
  function compact(n) {
    return n >= 1e9 ? `${Number((n / 1e9).toFixed(1))}B` : n >= 1e6 ? `${Number((n / 1e6).toFixed(1))}M` : n >= 1e3 ? `${Number((n / 1e3).toFixed(1))}k` : number(n);
  }
  function chart(times, series, metric, area = false, label = metric, width = 900, includeZero = true) {
    const height = 280, left = 55, top = 20, bottom = 245, plot = width - left - 14;
    const values = series.map(s => new Map(s.series.map(r => [r.time, r[metric]])));
    const sums = times.map(t => values.reduce((n, m) => n + (m.get(t) || 0), 0));
    const max = Math.max(1, ...sums), ceiling = max < 5 ? Math.ceil(max) : Math.ceil(max / (10 ** Math.floor(Math.log10(max)))) * (10 ** Math.floor(Math.log10(max)));
    const x = i => left + (i + .5) * plot / times.length, y = v => bottom - v / ceiling * (bottom - top);
    let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">`;
    for (const value of [ceiling, ceiling / 2, 0]) svg += `<line x1="${left}" x2="${width - 14}" y1="${y(value)}" y2="${y(value)}" class="usage-grid"/><text x="${left - 12}" y="${y(value) + 4}" text-anchor="end">${compact(value)}</text>`;
    if (area && values.length) {
      const points = times.map((t, i) => `${x(i)},${y(values[0].get(t) || 0)}`).join(" ");
      svg += `<polygon points="${x(0)},${bottom} ${points} ${x(times.length - 1)},${bottom}" fill="#9dcafa" fill-opacity=".85"/><polyline points="${points}" fill="none" stroke="#2685e6" stroke-width="2"/>`;
    }
    times.forEach((t, i) => {
      let stacked = 0;
      series.forEach((s, j) => {
        const value = values[j].get(t) || 0, barHeight = value / ceiling * (bottom - top);
        if (!area && value) svg += `<rect x="${x(i) - plot / times.length * .36}" y="${y(stacked + value)}" width="${plot / times.length * .72}" height="${barHeight}" rx="2" fill="${s.color || colors[j % colors.length]}"/>`;
        stacked += value;
      });
    });
    const indices = [...new Set([0, Math.floor((times.length - 1) / 3), Math.floor((times.length - 1) * 2 / 3), times.length - 1])];
    for (const i of indices) {
      const text = times[i].length > 10 ? times[i].slice(11) : times[i].slice(5).replace("-", "/");
      svg += `<text x="${x(i)}" y="${height - 12}" text-anchor="middle">${text}</text>`;
    }
    if (!sums.some(Boolean)) svg += `<text x="${width / 2}" y="${height / 2}" text-anchor="middle">暂无用量</text>`;
    times.forEach((time, i) => {
      const items = series.map((s, j) => ({name: s.name, color: s.color || colors[j % colors.length], value: values[j].get(time) || 0}))
        .filter(item => includeZero || item.value);
      const data = esc(JSON.stringify({time, total: sums[i], items}));
      svg += `<g class="usage-hit" data-usage="${data}"><rect x="${left + i * plot / times.length}" y="${top}" width="${plot / times.length}" height="${bottom - top}" fill="transparent"/>` +
        `<line class="usage-guide" x1="${x(i)}" x2="${x(i)}" y1="${top}" y2="${bottom}"/>` +
        (area ? `<circle class="usage-point" cx="${x(i)}" cy="${y(sums[i])}" r="4"/>` : "") + "</g>";
    });
    return svg + "</svg>";
  }
  function render(data) {
    const position = hoverPosition;
    hideTooltip();
    const u = data.usage, times = buckets(data);
    el("lifetime").textContent = number(data.lifetime.total_tokens);
    el("input").textContent = number(u.input_tokens);
    el("cached").textContent = `缓存命中 ${number(u.cached_tokens)}`;
    el("requests").textContent = number(u.requests);
    el("outcomes").textContent = `成功 ${number(u.successful)} · 失败 ${number(u.failed)} · 中断 ${number(u.interrupted)} · 进行中 ${number(u.running)}`;
    el("total").textContent = number(u.total_tokens);
    el("output").textContent = `输出 ${number(u.output_tokens)}`;
    el("trend-total").textContent = number(u.total_tokens);
    el("trend-chart").innerHTML = chart(times, data.groups, "total_tokens", false, "Token 用量趋势，按" + (data.group === "key" ? "API Key" : "调用类型") + "分组", 900, false);
    el("legend").replaceChildren();
    data.groups.forEach((g, i) => {
      const label = document.createElement("span"), swatch = document.createElement("i");
      swatch.style.backgroundColor = colors[i % colors.length]; label.append(swatch, document.createTextNode(g.name)); el("legend").append(label);
    });
    const currentKeys = data.keys.filter(k => k.state !== "deleted"), selected = el("key").value;
    el("key").replaceChildren(new Option("全部", ""), ...currentKeys.map(k => new Option(k.name, k.id)));
    el("key").value = currentKeys.some(k => k.id === selected) ? selected : "";
    el("groups").replaceChildren();
    for (const g of data.model_groups) {
      const section = document.createElement("section"), heading = document.createElement("h2"), pair = document.createElement("div");
      section.className = "usage-group"; heading.textContent = g.name; pair.className = "usage-pair";
      for (const [field, label] of [["requests", "API 请求次数"], ["total_tokens", "Tokens"]]) {
        const card = document.createElement("div"), title = document.createElement("h3"); card.className = "usage-card";
        title.textContent = `${label}  ${number(g.usage[field])}`; card.append(title);
        const graph = document.createElement("div");
        const series = field === "requests" ? [{...g, name: "API 请求次数"}] : [
          {name: "输入（命中缓存）", color: "#a3def3", series: g.series.map(r => ({...r, total_tokens: r.cached_tokens}))},
          {name: "输入（未命中缓存）", color: "#34b1d6", series: g.series.map(r => ({...r, total_tokens: r.input_tokens - r.cached_tokens}))},
          {name: "输出", color: "#3b82f6", series: g.series.map(r => ({...r, total_tokens: r.output_tokens}))}];
        graph.innerHTML = chart(times, series, field, field === "requests", `${g.name} ${label}`, 450); card.append(graph); pair.append(card);
      }
      const note = document.createElement("p"); note.className = "usage-note";
      note.textContent = `输入 ${number(g.usage.input_tokens)} · 缓存输入 ${number(g.usage.cached_tokens)} · 输出 ${number(g.usage.output_tokens)}`;
      section.append(heading, pair, note); el("groups").append(section);
    }
    el("rows").replaceChildren();
    for (const key of currentKeys.filter(k => !data.key_id || k.id === data.key_id)) {
      const row = document.createElement("tr"), name = document.createElement("td"), link = document.createElement("button");
      link.type = "button"; link.textContent = key.name; link.className = "usage-key-link";
      link.onclick = () => { el("key").value = key.id; refresh(); };
      name.append(link); row.append(name);
      for (const text of [states[key.state], ...fields.map(f => number(key.usage[f]))]) {
        const cell = document.createElement("td"); cell.textContent = text; row.append(cell);
      }
      el("rows").append(row);
    }
    el("empty").hidden = u.requests > 0;
    el("updated").textContent = `更新于 ${new Date().toLocaleString("zh-CN", {timeZone: data.timezone, hour12: false})} · ${data.from} 至 ${data.to}` +
      (u.incomplete ? ` · ${number(u.incomplete)} 条请求正在执行或未完整结算，Token 可能不完整。` : "");
    for (const value of ["key", "path"]) el(`group-${value}`).setAttribute("aria-pressed", String(data.group === value));
    if (position && tab === "usage") {
      const version = revision;
      requestAnimationFrame(() => {
        if (version !== revision || tab !== "usage") return;
        const target = document.elementFromPoint(position.clientX, position.clientY);
        if (target) showTooltip({...position, target});
      });
    }
  }
  function clear() {
    hideTooltip();
    ++revision; clearTimeout(timer); result = null;
    el("workspace").hidden = true; el("logout").hidden = true; el("login").hidden = false; el("export").disabled = true;
    el("workspace").setAttribute("aria-busy", "false");
    for (const name of ["rows", "groups", "trend-chart", "legend"]) el(name).replaceChildren();
    for (const name of ["lifetime", "input", "cached", "requests", "outcomes", "total", "output", "trend-total"]) el(name).textContent = "–";
    el("updated").textContent = "";
    el("key").replaceChildren(new Option("全部", ""));
  }
  async function refresh() {
    clearTimeout(timer);
    if (tab !== "usage" || !admin.hasCredential() || !health.key_management) return;
    const version = ++revision;
    el("export").disabled = true; el("workspace").setAttribute("aria-busy", "true");
    try {
      const params = query();
      if (!result) message("正在加载用量…");
      const data = await admin.request(`api/keys/usage?${params}`);
      if (version !== revision || !admin.hasCredential()) return;
      result = data; render(data); message();
      el("workspace").hidden = false; el("logout").hidden = false; el("login").hidden = true; el("export").disabled = false;
    } catch (e) {
      if (version === revision) { result = null; message(e.message, true); el("updated").textContent = "加载失败，当前显示为上次成功加载的数据。请刷新重试。"; }
    } finally {
      if (version === revision) {
        el("workspace").setAttribute("aria-busy", "false");
        if (tab === "usage" && admin.hasCredential()) timer = setTimeout(refresh, 10000);
      }
    }
  }
  function csvCell(value) {
    const text = String(value);
    return '"' + (/^[=+\-@\t\r]/.test(text) ? "'" : "") + text.replace(/"/g, '""') + '"';
  }
  async function download() {
    if (!result) return;
    const version = revision, snapshot = result;
    el("export").disabled = true;
    try {
      const params = new URLSearchParams({from: snapshot.from, to: snapshot.to, interval: snapshot.interval, timezone: snapshot.timezone, group: "key", ...(snapshot.key_id ? {key_id: snapshot.key_id} : {})});
      const data = snapshot.group === "key" ? snapshot : await admin.request(`api/keys/usage?${params}`);
      if (version !== revision || !admin.hasCredential()) return;
      const keys = new Map(data.keys.map(k => [k.id, k]));
      const lines = [["时间", "时区", "Key ID", "名称", "状态", "请求次数", "成功", "失败", "中断", "进行中", "输入 Tokens", "缓存输入", "输出 Tokens", "总 Tokens", "未完整结算"]];
      for (const g of data.groups) for (const row of g.series) lines.push([row.time, data.timezone, g.id, g.name, states[keys.get(g.id).state], ...fields.map(f => row[f])]);
      const url = URL.createObjectURL(new Blob(["\ufeff" + lines.map(row => row.map(csvCell).join(",")).join("\r\n")], {type: "text/csv;charset=utf-8"}));
      const link = document.createElement("a"); link.href = url; link.download = `strata-usage-${data.from}-${data.to}.csv`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); message("已导出按 API Key 分组的用量明细。");
    } catch (e) { if (version === revision) message(e.message, true); }
    finally { if (version === revision && result) el("export").disabled = false; }
  }
  function enter() {
    clearTimeout(timer);
    if (!admin.hasCredential()) clear();
    if (tab !== "usage" || !health.service) return;
    if (!health.key_management) { message("此服务尚未启用 API Key 管理。", true); return; }
    if (admin.hasCredential()) refresh();
  }
  el("login").onsubmit = async event => {
    event.preventDefault(); admin.login(el("admin").value.trim()); el("admin").value = "";
    const submit = el("login").querySelector("button"); submit.disabled = true;
    try { await refresh(); } finally { submit.disabled = false; }
  };
  el("logout").onclick = () => { admin.logout(); message("已退出管理，当前标签页的管理凭证已清除。"); };
  el("range").onchange = () => { el("dates").hidden = el("range").value !== "custom"; refresh(); };
  el("key").onchange = refresh; el("apply").onclick = refresh; el("refresh").onclick = refresh; el("export").onclick = download;
  el("zone").onchange = () => {
    el("zone-note").textContent = `所有日期均按 ${el("zone").value === "UTC" ? "UTC+0" : "GMT+8"} 时间显示。统计本服务的 API 调用，数据每 10 秒刷新。`;
    refresh();
  };
  for (const value of ["key", "path"]) el(`group-${value}`).onclick = () => { group = value; refresh(); };
  el("from").value = day(-29); el("to").value = day();
  document.addEventListener("strata-usage-view", enter); document.addEventListener("strata-health", enter);
  document.addEventListener("strata-admin-session", () => { if (!admin.hasCredential()) { clear(); message(); } });
  el("workspace").addEventListener("pointermove", showTooltip);
  el("workspace").addEventListener("pointerleave", hideTooltip);
  el("workspace").addEventListener("pointercancel", hideTooltip);
  el("workspace").addEventListener("click", showTooltip);
  document.getElementById("view-usage").addEventListener("scroll", hideTooltip, true);
  window.addEventListener("resize", hideTooltip);
  window.addEventListener("hashchange", hideTooltip);
  window.addEventListener("blur", hideTooltip);
  enter();
})();
