import { clock, createTrace, formatValue } from "./trace.js";

const get = id => document.getElementById(id);
const formData = form => Object.fromEntries(new FormData(form));
const localTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const devicePath = id => "/api/devices/" + encodeURIComponent(id);
const isNumeric = field => ["number", "integer"].includes(field.type);

const tokenKey = "janus.accessToken";
export const accessToken = () => sessionStorage.getItem(tokenKey);

export async function api(path, method = "GET", data, signal) {
  const headers = {};
  const token = accessToken();
  if (token && path !== "/api/auth/login") headers.Authorization = "Bearer " + token;
  if (data !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    method, headers, cache: "no-store", signal, body: JSON.stringify(data),
  });
  if (response.status === 401 && headers.Authorization && token === accessToken()) {
    sessionStorage.removeItem(tokenKey);
    location.replace("/");
  }
  const result = await response.json();
  if (!response.ok) {
    const message = Array.isArray(result.detail) ? result.detail.map(error => error.msg).join(" ") : result.detail;
    throw new Error(message || "Request failed.");
  }
  return result;
}

function node(tag, text = "", className = "") {
  const item = document.createElement(tag);
  item.textContent = text;
  item.className = className;
  return item;
}

function button(label, click, style = "secondary") {
  const action = node("button", label, style);
  action.type = "button";
  action.addEventListener("click", click);
  return action;
}

function feedback(id, text = "", error = false) {
  const output = get(id);
  output.textContent = text;
  output.hidden = !text;
  output.classList.toggle("error", error);
}

function list(id, items, empty) {
  const target = get(id);
  target.replaceChildren();
  if (!items.length) {
    target.append(node("p", empty, "placeholder"));
    return;
  }
  const rows = node("ul", "", "records");
  for (const { title, detail, actions = [] } of items) {
    const row = node("li");
    const text = node("div");
    text.append(node("strong", title));
    if (detail) text.append(node("small", detail));
    row.append(text);
    if (actions.length) {
      const controls = node("div", "", "actions");
      controls.append(...actions);
      row.append(controls);
    }
    rows.append(row);
  }
  target.append(rows);
}

function confirmAction(title, description, label) {
  const dialog = get("confirm-dialog");
  get("confirm-title").textContent = title;
  get("confirm-description").textContent = description;
  get("confirm-action").textContent = label;
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }));
}

function localInput(ms) {
  const date = new Date(ms);
  return new Date(ms - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}

export async function createWorkspace({ connect, refresh }) {
  let user = null;
  if (accessToken()) {
    try { user = await api("/api/auth/me"); }
    catch (error) { feedback("login-error", error.message, true); }
  }
  let view = "live";
  let tab = "users";
  let device;
  let schema;
  let devices = [];
  let serial = 0;
  let historyRequest = 0;
  let historyObservers = [];
  let editingRule;
  let commandResult;
  let sending = false;
  let canCommand = false;
  const recentAcks = new Map();

  function open() {
    get("login").hidden = Boolean(user);
    get("workspace").hidden = !user;
    get("logout").hidden = !user;
    for (const link of document.querySelectorAll("[data-session]")) link.hidden = !user;
    for (const link of document.querySelectorAll("[data-admin]")) link.hidden = !user?.is_admin;
    route();
    if (user) connect();
  }

  get("login-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector("button");
    submit.disabled = true;
    try {
      const login = await api("/api/auth/login", "POST", formData(form));
      sessionStorage.setItem(tokenKey, login.access_token);
      user = await api("/api/auth/me");
      form.reset();
      feedback("login-error");
      open();
    } catch (error) {
      feedback("login-error", error.message, true);
    } finally {
      submit.disabled = false;
    }
  });
  get("logout").addEventListener("click", async () => {
    sessionStorage.removeItem(tokenKey);
    location.replace("/");
  });

  function route() {
    const [path, subview] = location.hash.slice(1).split("/");
    const allowed = user ? ["live", "history", "alerts", ...(user.is_admin ? ["admin"] : [])] : ["live"];
    const previous = view;
    view = allowed.includes(path) ? path : "live";
    if (view === "history" && previous !== "history") {
      const now = Date.now();
      get("history-start").value = localInput(now - 60000);
      get("history-end").value = localInput(now);
    }
    tab = ["users", "devices", "access", "rules"].includes(subview) ? subview : "users";
    get("view-title").textContent = { live: "Live telemetry", history: "Past telemetry", alerts: "Alerts", admin: "Administration" }[view];
    get("window-control").hidden = view !== "live";
    get("toolbar-actions").hidden = view === "admin" && !["access", "rules"].includes(tab);
    get("jump-commands").hidden = view !== "live" || !canCommand;
    for (const name of ["live", "history", "alerts", "admin"]) {
      get("view-" + name).hidden = name !== view;
      document.querySelector('[data-view="' + name + '"]').setAttribute("aria-current", name === view ? "page" : "false");
    }
    for (const name of ["users", "devices", "access", "rules"]) {
      get("admin-" + name).hidden = name !== tab;
      document.querySelector('[data-admin-tab="' + name + '"]').setAttribute("aria-current", name === tab ? "page" : "false");
    }
    refreshView();
  }

  async function refreshView() {
    const version = ++serial;
    const id = device?.id;
    const path = id ? devicePath(id) : "";
    const current = () => version === serial;
    try {
      if (view === "alerts") {
        if (!id) return list("alert-rows", [], "Select a device to see its alerts.");
        list("alert-rows", [], "Loading alerts…");
        const result = await api("/api/alerts/history");
        if (current()) renderAlerts(result.alerts.filter(alert => alert.device_id === id));
      }
      if (view !== "admin") return;
      if (tab === "devices") {
        list("registered-rows", devices.map(entry => ({
          title: entry.name || entry.id, detail: entry.id,
          actions: [button("Remove", async () => {
            if (!await confirmAction("Remove " + (entry.name || entry.id) + "?", "This removes its readings, alert rules, and access grants.", "Remove device")) return;
            try {
              await api(devicePath(entry.id), "DELETE");
              await refresh();
              feedback("remove-status", "Device removed.");
            } catch (error) { feedback("remove-status", error.message, true); }
          }, "danger")],
        })), "No registered devices.");
      } else if (tab === "access") {
        for (const control of get("access-form").querySelectorAll("button")) control.disabled = !id;
      } else if (tab === "rules") {
        get("rule-form").querySelector("button").disabled = !id || !get("rule-form").elements.metric.options.length;
        list("rule-rows", [], id ? "Loading rules…" : "Select a device to manage alert rules.");
        if (!id) return;
        const result = await api(path + "/alerts");
        if (!current()) return;
        list("rule-rows", result.rules.map(rule => ({
          title: (schema?.telemetry[rule.metric]?.label ?? rule.metric) + " " + rule.operator + " " + formatValue(rule.threshold),
          detail: rule.enabled ? "Enabled" : "Disabled",
          actions: [
            button("Edit", () => editRule(rule)),
            button("Delete", async () => {
              if (!await confirmAction("Delete alert rule?", "Existing alerts stay in the log.", "Delete rule")) return;
              try {
                await api(path + "/alerts/" + rule.id, "DELETE");
                if (editingRule === rule.id) editRule();
                feedback("rule-status", "Rule deleted.");
                refreshView();
              } catch (error) { feedback("rule-status", error.message, true); }
            }, "danger"),
          ],
        })), "No alert rules for this device.");
      }
    } catch (error) {
      if (!current()) return;
      const target = view === "alerts" ? "alert-rows" : { rules: "rule-rows", devices: "registered-rows" }[tab];
      if (target) list(target, [], error.message);
    }
  }

  function editRule(rule) {
    const form = get("rule-form");
    editingRule = rule?.id;
    form.reset();
    get("rule-title").textContent = rule ? "Edit alert rule" : "Create alert rule";
    get("cancel-rule").hidden = !rule;
    get("rule-enabled").hidden = !rule;
    if (rule) {
      form.elements.metric.value = rule.metric;
      form.elements.operator.value = rule.operator;
      form.elements.threshold.value = rule.threshold;
      form.elements.enabled.checked = Boolean(rule.enabled);
      form.elements.metric.focus();
    }
  }

  function renderAlerts(entries) {
    list("alert-rows", entries.map(entry => {
      const field = schema?.telemetry[entry.metric];
      const time = new Date(entry.triggered_at.replace(" ", "T") + "Z");
      return {
        title: (field?.label ?? entry.metric) + " " + entry.operator + " " + formatValue(entry.threshold),
        detail: "Rule " + entry.rule_id + " · Reading " + formatValue(entry.value) + " " +
          (field?.unit ?? "") + " · " + localTime.format(time),
      };
    }), "No alerts for this device.");
  }

  function clearHistory() {
    historyRequest++;
    historyObservers.forEach(observer => observer.disconnect());
    historyObservers = [];
    get("history-results").replaceChildren();
    feedback("history-status");
  }

  function commandForm(name, command) {
    const target = node("form", "", "stacked command-form");
    target.append(node("h3", command.label || name));
    const args = command.args ?? {};
    for (const [key, field] of Object.entries(args)) {
      const label = node("label", (field.label ?? key) + (field.unit ? " (" + field.unit + ")" : ""));
      const input = document.createElement("input");
      input.name = key;
      if (isNumeric(field)) {
        input.type = "number";
        input.step = field.type === "integer" ? "1" : "any";
        if (field.min != null) input.min = field.min;
        if (field.max != null) input.max = field.max;
        input.required = true;
      } else if (field.type === "boolean") {
        input.type = "checkbox";
        label.className = "inline-check";
      }
      label.append(input);
      target.append(label);
    }
    const submit = node("button", "Send command", "primary");
    target.append(submit);
    target.addEventListener("submit", event => {
      event.preventDefault();
      sendCommand(name, target);
    });
    return target;
  }

  function context(nextDevice, nextSchema, nextDevices) {
    if (!user) return;
    const inventoryChanged = nextDevices.map(entry => entry.id + ":" + entry.name).join("|") !== devices.map(entry => entry.id + ":" + entry.name).join("|");
    const contextChanged = nextDevice?.id !== device?.id || nextSchema !== schema;
    if (inventoryChanged && !nextDevices.some(entry => entry.id === get("live-alert").dataset.device)) {
      feedback("live-alert");
    }
    devices = nextDevices;
    device = nextDevice;
    schema = nextSchema;
    canCommand = Boolean(device && device.role && device.role !== "viewer" && Object.keys(schema?.commands ?? {}).length);
    get("commands").hidden = !canCommand;
    get("jump-commands").hidden = view !== "live" || !canCommand;
    for (const submit of get("command-forms").querySelectorAll("button")) {
      submit.disabled = !device?.online || sending || Boolean(commandResult?.pending);
    }
    if (!contextChanged) {
      if (inventoryChanged && view === "admin" && tab === "devices") refreshView();
      return;
    }
    commandResult = undefined;
    feedback("command-result");
    get("command-forms").replaceChildren(...Object.entries(schema?.commands ?? {}).map(([name, spec]) => commandForm(name, spec)));
    const fields = get("history-fields");
    fields.replaceChildren(...Object.entries(schema?.telemetry ?? {}).map(([key, field], index) => {
      const label = node("label", field.label ?? key, "choice");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "field";
      input.value = key;
      input.checked = index === 0;
      label.prepend(input);
      return label;
    }));
    get("query-history").disabled = !fields.children.length;
    clearHistory();
    get("rule-form").elements.metric.replaceChildren(...Object.entries(schema?.telemetry ?? {}).filter(([, field]) => isNumeric(field))
      .map(([key, field]) => new Option(field.label ?? key, key)));
    editRule();
    refreshView();
  }

  function finishCommand(ack) {
    if (!commandResult || commandResult.id !== ack.id || commandResult?.device !== ack.device_id) return;
    commandResult.pending = false;
    feedback("command-result", (ack.ok ? "Acknowledged" : ack.error || "Rejected") + " · " + ack.id, !ack.ok);
  }

  function message(payload) {
    if (payload.type === "alert") {
      get("live-alert").dataset.device = payload.device_id;
      feedback("live-alert", payload.device_id + " · " + payload.metric + " " + payload.operator + " " +
        formatValue(payload.threshold) + " · Reading " + formatValue(payload.value));
      if (view === "alerts" && device?.id === payload.device_id) refreshView();
    } else if (payload.type === "ack") {
      recentAcks.set(payload.id, payload);
      if (recentAcks.size > 64) recentAcks.delete(recentAcks.keys().next().value);
      finishCommand(payload);
    } else if (["access_changed", "device_removed"].includes(payload.type)) {
      refresh();
    }
  }

  function bindForm(id, status, action) {
    const form = get(id);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const submit = form.querySelector('button:not([type="button"])');
      submit.disabled = true;
      feedback(status);
      try { await action(form); }
      catch (error) { feedback(status, error.message, true); }
      finally { submit.disabled = false; }
    });
  }

  bindForm("user-form", "user-status", async form => {
    const result = await api("/api/users", "POST", formData(form));
    form.reset();
    feedback("user-status", result.username + " was created.");
    refreshView();
  });
  get("schema-file").addEventListener("change", async event => {
    const file = event.target.files[0];
    if (file) get("device-form").elements.schema.value = await file.text();
  });
  bindForm("device-form", "register-status", async form => {
    let data;
    try { data = JSON.parse(form.elements.schema.value); }
    catch { throw new Error("Enter a valid JSON schema."); }
    const result = await api("/api/devices", "POST", data);
    form.reset();
    await refresh();
    feedback("register-status", result.id + " was registered.");
  });
  bindForm("access-form", "access-status", async form => {
    await api(devicePath(device.id) + "/permissions", "PUT", formData(form));
    feedback("access-status", "Access saved.");
    refreshView();
  });
  get("revoke").addEventListener("click", async () => {
    const username = get("access-form").elements.username;
    if (!device || !username.reportValidity()) return;
    const id = device.id;
    const name = username.value;
    if (!await confirmAction("Revoke access?", name + " will lose access to " + id + ".", "Revoke access")) return;
    try {
      await api(devicePath(id) + "/permissions/" + encodeURIComponent(name), "DELETE");
      feedback("access-status", "Access revoked.");
    } catch (error) { feedback("access-status", error.message, true); }
  });
  bindForm("rule-form", "rule-status", async form => {
    const data = formData(form);
    data.threshold = form.elements.threshold.valueAsNumber;
    data.enabled = form.elements.enabled.checked;
    const previous = editingRule;
    const path = devicePath(device.id) + "/alerts" + (previous ? "/" + previous : "");
    await api(path, previous ? "PUT" : "POST", data);
    editRule();
    feedback("rule-status", previous ? "Rule updated." : "Rule created.");
    refreshView();
  });
  get("cancel-rule").addEventListener("click", () => editRule());
  get("refresh-alerts").addEventListener("click", refreshView);
  get("jump-commands").addEventListener("click", () => get("command-forms").querySelector("input, button")?.focus());
  async function sendCommand(name, form) {
    if (sending || commandResult?.pending || !device?.online || !device.role || device.role === "viewer") return;
    const id = device.id;
    const args = Object.fromEntries([...form.querySelectorAll("input")].map(input => [
      input.name, input.type === "number" ? input.valueAsNumber : input.type === "checkbox" ? input.checked : input.value,
    ]));
    sending = true;
    form.querySelector("button").disabled = true;
    feedback("command-result", "Sending…");
    try {
      const result = await api(devicePath(id) + "/commands", "POST", { name, args });
      if (device?.id !== id) return;
      const pending = { id: result.id, device: id, pending: true };
      commandResult = pending;
      const ack = recentAcks.get(result.id);
      if (ack) finishCommand(ack);
      else {
        feedback("command-result", "Waiting for device · " + result.id);
        setTimeout(() => {
          if (commandResult === pending && pending.pending) {
            pending.pending = false;
            feedback("command-result", "No acknowledgement received · " + result.id, true);
          }
        }, 8000);
      }
    } catch (error) {
      if (device?.id === id) feedback("command-result", error.message, true);
    } finally {
      sending = false;
    }
  }

  get("query-history").disabled = true;
  bindForm("history-form", "history-status", async form => {
    const fields = new FormData(form).getAll("field");
    if (!fields.length) throw new Error("Choose at least one field.");
    if (!device || !schema) throw new Error("Select a device with a schema.");
    const start = new Date(get("history-start").value).getTime();
    const end = new Date(get("history-end").value).getTime();
    if (!(start < end) || end - start > 14 * 86400000) throw new Error("Choose a time range of up to 14 days.");
    clearHistory();
    const request = historyRequest;
    const selectedSchema = schema;
    const query = new URLSearchParams({ start: start / 1000, end: end / 1000 });
    for (const field of fields) query.append("fields", field);
    const result = await api(devicePath(device.id) + "/telemetry?" + query);
    if (request !== historyRequest) return;
    if (!result.samples.length) return feedback("history-status", "No readings in this time range.");
    for (const key of fields) {
      const field = selectedSchema.telemetry[key];
      const name = field.label ?? key;
      const panel = node("section", "", "panel form-panel");
      const heading = node("h2", name + (field.unit ? " · " + field.unit : ""));
      panel.append(heading);
      get("history-results").append(panel);
      if (!isNumeric(field)) {
        const values = node("ul", "", "records");
        for (const sample of result.samples.slice(-25)) {
          values.append(node("li", clock.format(sample.timestamp * 1000) + " · " + String(sample.data[key] ?? "—")));
        }
        panel.append(values);
        continue;
      }
      const chart = node("div", "", "chart history-chart");
      const canvas = node("canvas");
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", name + " over the selected period");
      const tooltip = node("output", "", "tooltip");
      tooltip.hidden = true;
      chart.append(canvas, tooltip);
      panel.append(chart);
      const points = result.samples.filter(sample => Number.isFinite(sample.data[key])).map(sample => ({
        time: sample.timestamp * 1000, value: sample.data[key],
      }));
      if (!points.length) chart.replaceChildren(node("p", "No numeric readings in this window.", "placeholder"));
      else {
        const draw = createTrace(canvas, tooltip, chart);
        const update = () => draw(points, start, end, field.unit ?? "", Math.max(1000, (end - start) / 200), true);
        const observer = new ResizeObserver(update);
        observer.observe(chart);
        historyObservers.push(observer);
        for (const type of ["pointermove", "pointerleave", "pointercancel"]) canvas.addEventListener(type, update);
      }
    }
  });

  window.addEventListener("hashchange", route);
  return { open, context, message, checkSession: () => api("/api/auth/me") };
}
