import { clock, createTrace, formatValue } from "./trace.js";
import { accessToken, api, createWorkspace } from "./workspace.js";

const get = id => document.getElementById(id);
const ui = Object.fromEntries([
  "context", "device-picker", "range", "metrics", "chart-title", "chart-state", "chart",
  "trace", "tooltip", "chart-empty", "devices", "device-count", "devices-empty",
  "details", "details-empty", "description", "device-id", "rate", "last-reading",
].map(id => [id, get(id)]));
const devices = new Map();
const schemas = new Map();
const metricButtons = new Map();
const drawTrace = createTrace(ui.trace, ui.tooltip, ui.chart);
const chartDeck = get("all-charts");
const toggleCharts = get("toggle-charts");
const fieldCharts = new Map();
let showAll = false;
let draggedChart;
const requestedId = new URLSearchParams(location.search).get("device");

let selected;
let selectedMetric;
let displayedSchema;
let connection = "pending";
let discovered = false;
let discoveryError = false;
let retry = 500;
let eventsDuringDiscovery = null;
let liveSocket;
let workspace;

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function element(tag, className, text = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function selectDevice(device) {
  if (selected === device) return;
  selected = device;
  selectedMetric = undefined;
  displayedSchema = null;
  metricButtons.clear();
  ui.metrics.replaceChildren();
}

function chooseDevice(device) {
  selectDevice(device);
  const url = new URL(location.href);
  url.searchParams.set("device", device.id);
  history.replaceState(null, "", url);
  render();
}

function remember(id, schemaId) {
  if (devices.has(id)) {
    const device = devices.get(id);
    if (schemaId && device.schemaId !== schemaId) {
      device.schemaId = schemaId;
      loadSchema(schemaId);
    }
    return device;
  }

  const device = { id, schemaId: schemaId || id, online: null, samples: [], latest: null };
  const row = document.createElement("li");
  const button = element("button", "device");
  button.type = "button";
  const name = element("span", "device-name");
  const label = document.createElement("span");
  const state = element("span", "device-state");
  name.append(label, element("small", "", id));
  button.append(name, state);
  button.addEventListener("click", () => {
    chooseDevice(device);
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    ui["chart-title"].scrollIntoView({ behavior, block: "nearest" });
  });
  row.append(button);
  ui.devices.append(row);

  const option = new Option(id, id);
  ui["device-picker"].add(option);
  Object.assign(device, { button, label, state, option });
  devices.set(id, device);
  loadSchema(device.schemaId);
  return device;
}

async function loadSchema(id) {
  if (schemas.has(id)) return;
  const pending = Symbol();
  schemas.set(id, pending);
  try {
    const schema = await api("/api/devices/" + encodeURIComponent(id) + "/schema");
    if (!schema.telemetry || typeof schema.telemetry !== "object") throw new Error("Invalid telemetry schema");
    if (schemas.get(id) === pending) schemas.set(id, schema);
  } catch {
    if (schemas.get(id) === pending) schemas.set(id, null);
  }
}

function getSchema(id) {
  const schema = schemas.get(id);
  return typeof schema === "symbol" ? undefined : schema;
}

async function seedHistory(device, schema) {
  device.seeded = true;
  try {
    const end = Date.now() / 1000;
    const query = new URLSearchParams({ start: end - 60, end });
    for (const key of Object.keys(schema.telemetry)) query.append("fields", key);
    const path = "/api/devices/" + encodeURIComponent(device.id) + "/telemetry?" + query;
    const { samples } = await api(path, "GET", undefined, AbortSignal.timeout(4000));
    if (devices.get(device.id) !== device) return;
    const readings = new Map(samples.map(sample => [sample.timestamp * 1000, {
      time: sample.timestamp * 1000, data: sample.data,
    }]));
    for (const sample of device.samples) readings.set(sample.time, sample);
    device.samples = [...readings.values()].sort((a, b) => a.time - b.time);
    device.latest = device.samples.at(-1) ?? device.latest;
  } catch {
    // The live stream continues to populate the chart if history is unavailable.
  }
}

async function discover(socket) {
  const touched = new Set();
  eventsDuringDiscovery = touched;
  try {
    const { devices: ids, device_details: details = {} } = await api("/api/devices", "GET", undefined, AbortSignal.timeout(4000));
    if (socket.readyState !== WebSocket.OPEN || eventsDuringDiscovery !== touched) return;
    const current = new Set([...ids, ...Object.keys(details)]);
    for (const id of current) {
      const device = remember(id, details[id]?.schema_id);
      device.role = details[id]?.role;
      device.name = details[id]?.name;
      device.lastSeen = details[id]?.last_seen;
      if (!touched.has(id)) device.online = details[id]?.connected ?? ids.includes(id);
    }
    for (const device of devices.values()) {
      if (current.has(device.id)) continue;
      devices.delete(device.id);
      schemas.delete(device.id);
      device.button.parentElement.remove();
      device.option.remove();
      if (selected === device) selectDevice(undefined);
    }
    if (!selected) selectDevice(devices.get(requestedId) ?? [...devices.values()].find(device => device.online) ?? devices.values().next().value);
    discovered = true;
    discoveryError = false;
    render();
  } catch {
    if (socket.readyState === WebSocket.OPEN && eventsDuringDiscovery === touched) {
      discoveryError = true;
      setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) discover(socket);
      }, 2500);
    }
  } finally {
    if (eventsDuringDiscovery === touched) eventsDuringDiscovery = null;
  }
}

function receive(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  const { device_id: id, type, data } = message ?? {};
  if (message) workspace.message(message);
  if (typeof id !== "string" || (type !== "status" && type !== "telemetry")) return;
  const device = remember(id);
  eventsDuringDiscovery?.add(id);
  if (type === "status") {
    device.online = message.connected === true;
  } else if (data && typeof data === "object") {
    device.online = true;
    const parsedTime = Number.isFinite(message.timestamp) ? message.timestamp * 1000 : Date.parse(message.received_at);
    const time = Number.isFinite(parsedTime) ? parsedTime : Date.now();
    if (time >= (device.latest?.time ?? 0)) {
      device.latest = { time, data };
      device.samples.push(device.latest);
      if (device.samples.length > 6000) device.samples.splice(0, 1000);
    }
  }
  if (!selected && (id === requestedId || !eventsDuringDiscovery)) selectDevice(device);
}

function connect() {
  const endpoint = new URL("/ws/live", location.href);
  endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  endpoint.searchParams.set("token", accessToken());
  const socket = new WebSocket(endpoint);
  liveSocket = socket;
  socket.addEventListener("open", () => {
    retry = 500;
    connection = "live";
    discover(socket);
    render();
  });
  socket.addEventListener("message", receive);
  socket.addEventListener("close", async () => {
    connection = "pending";
    for (const device of devices.values()) device.online = null;
    render();
    if (socket.readyState === WebSocket.CLOSED) {
      try {
        await workspace.checkSession();
      } catch {
        // The server may be restarting. Retry the stream below.
      }
    }
    if (!accessToken()) return;
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 5000);
  });
}

function addChart(key, field) {
  const card = element("section", "field-chart");
  const title = field.label || key;
  const handle = element("button", "chart-handle", title + (field.unit ? " · " + field.unit : ""));
  handle.type = "button";
  handle.draggable = true;
  handle.title = "Drag to reorder or use the arrow keys";
  handle.addEventListener("dragstart", event => {
    draggedChart = card;
    event.dataTransfer.setData("text/plain", key);
    event.dataTransfer.effectAllowed = "move";
  });
  handle.addEventListener("dragend", () => { draggedChart = undefined; });
  handle.addEventListener("keydown", event => {
    const forward = ["ArrowRight", "ArrowDown"].includes(event.key);
    if (!forward && !["ArrowLeft", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const sibling = forward ? card.nextElementSibling : card.previousElementSibling;
    if (sibling) {
      if (forward) sibling.after(card);
      else sibling.before(card);
      handle.focus();
    }
  });
  card.addEventListener("dragover", event => { if (draggedChart) event.preventDefault(); });
  card.addEventListener("drop", event => {
    event.preventDefault();
    if (!draggedChart || draggedChart === card) return;
    if (draggedChart.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) card.after(draggedChart);
    else card.before(draggedChart);
  });
  const chart = element("div", "chart");
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", title + " over time");
  const tooltip = element("output", "tooltip");
  tooltip.hidden = true;
  chart.append(canvas, tooltip);
  card.append(handle, chart);
  chartDeck.append(card);
  fieldCharts.set(key, createTrace(canvas, tooltip, chart));
}

function setChartMode(all) {
  showAll = all;
  chartDeck.hidden = !all;
  ui.chart.hidden = all;
  get("single-heading").hidden = all;
  toggleCharts.textContent = all ? "Show one chart" : "Show all charts";
  toggleCharts.setAttribute("aria-pressed", String(all));
}

function renderMetrics(schema) {
  if (schema === displayedSchema) return;
  displayedSchema = schema;
  selectedMetric = undefined;
  metricButtons.clear();
  ui.metrics.replaceChildren();
  fieldCharts.clear();
  chartDeck.replaceChildren();
  toggleCharts.hidden = !schema || !Object.keys(schema.telemetry).length;
  if (!schema) {
    setChartMode(false);
    return;
  }
  const fields = Object.entries(schema.telemetry);
  ui.metrics.style.setProperty("--metric-columns", String(Math.min(Math.max(fields.length, 1), 4)));
  selectedMetric = fields.find(([, field]) => ["number", "integer"].includes(field.type))?.[0];
  for (const [key, field] of fields) {
    const label = element("span", "metric-label", field.label ?? key);
    const value = element("span", "metric-value", "—");
    const unit = element("span", "metric-unit", field.unit ?? "");
    const numeric = ["number", "integer"].includes(field.type);
    const metric = element(numeric ? "button" : "div", "metric");
    if (numeric) {
      addChart(key, field);
      metric.type = "button";
      metric.addEventListener("click", () => {
        setChartMode(false);
        selectedMetric = key;
        render();
      });
    }
    metric.append(label, value, unit);
    ui.metrics.append(metric);
    metricButtons.set(key, { metric, value });
  }
}

function render() {
  const now = Date.now();
  let online = 0;
  for (const device of devices.values()) {
    const schema = getSchema(device.schemaId);
    const state = device.online === true ? "Online" : device.online === false ? "Offline" : "Unknown";
    const name = schema?.name ?? device.name ?? device.id;
    setText(device.label, name);
    setText(device.option, device.schemaId === device.id ? name : name + " (" + device.id + ")");
    setText(device.state, state);
    device.state.dataset.state = state.toLowerCase();
    device.button.setAttribute("aria-pressed", String(device === selected));
    if (device.online) online++;
    const cutoff = now - 65_000;
    const firstRecent = device.samples.findIndex(sample => sample.time >= cutoff);
    if (firstRecent === -1) device.samples = [];
    else if (firstRecent > 0) device.samples.splice(0, firstRecent);
  }
  const count = connection === "live" ? online + " online / " + devices.size : String(devices.size);
  setText(ui["device-count"], devices.size ? count : "");
  ui["devices-empty"].hidden = devices.size > 0;
  setText(ui["devices-empty"], discoveryError ? "Device discovery unavailable. Retrying…" :
    discovered ? "No devices discovered yet." : "Discovering devices…");

  const schema = selected ? getSchema(selected.schemaId) : undefined;
  if (selected && schema && !selected.seeded) seedHistory(selected, schema);
  workspace.context(selected, schema, [...devices.values()]);
  renderMetrics(schema);
  ui.context.hidden = Boolean(selected);
  ui["device-picker"].hidden = !selected;
  if (selected) ui["device-picker"].value = selected.id;
  ui.details.hidden = !selected;
  ui["details-empty"].hidden = Boolean(selected);
  if (selected) {
    setText(ui.description, schema?.description ?? "");
    ui.description.hidden = !schema?.description;
    setText(ui["device-id"], selected.id);
    setText(ui.rate, schema?.rate_hz ? schema.rate_hz + " Hz" : "—");
    const lastTime = selected.latest?.time ?? selected.lastSeen * 1000;
    setText(ui["last-reading"], lastTime ? clock.format(lastTime) : "—");
  }

  for (const [key, { metric, value }] of metricButtons) {
    if (metric instanceof HTMLButtonElement) metric.setAttribute("aria-pressed", String(key === selectedMetric));
    const reading = selected.latest?.data[key];
    setText(value, Number.isFinite(reading) ? formatValue(reading) : ["string", "boolean"].includes(typeof reading) ? String(reading) : "—");
  }

  const field = schema?.telemetry[selectedMetric];
  const end = selected?.online === true ? now : selected?.latest?.time ?? now;
  const start = end - Number(ui.range.value) * 1000;
  const interval = Math.max(500, 3000 / (schema?.rate_hz || 1));
  if (showAll && selected && !get("view-live").hidden) {
    for (const [key, draw] of fieldCharts) {
      const points = selected.samples.filter(s => s.time >= start && s.time <= end && Number.isFinite(s.data[key]))
        .map(s => ({ time: s.time, value: s.data[key] }));
      draw(points, start, end, schema.telemetry[key].unit, interval);
    }
    return;
  }
  const points = [];
  if (field && selected) {
    for (const sample of selected.samples) {
      const value = sample.data[selectedMetric];
      if (sample.time >= start && sample.time <= end && Number.isFinite(value)) {
        points.push({ time: sample.time, value });
      }
    }
  }

  const title = field ? field.label ?? selectedMetric : "Signal trace";
  setText(ui["chart-title"], title);
  const chartState = selected?.online === true ? "Live" : selected?.online === false ? "Offline" : selected ? "Stream unavailable" : "";
  setText(ui["chart-state"], chartState);
  ui.trace.setAttribute("aria-label", title + (field?.unit ? " in " + field.unit : "") + " over time");
  ui["chart-empty"].hidden = points.length > 0;
  setText(ui["chart-empty"], !selected ? discovered ? "Waiting for a device to connect…" : "Waiting for device discovery…" :
    schema === null ? "Schema unavailable for this device." :
    !schema ? "Loading the device schema…" :
    !field ? "This schema has no numeric telemetry fields." :
    selected.online === false ? "This device is offline." : "Waiting for telemetry…");
  ui.trace.style.visibility = points.length ? "visible" : "hidden";
  drawTrace(points, start, end, field?.unit ?? "", interval);
}

toggleCharts.addEventListener("click", () => {
  setChartMode(!showAll);
  render();
});
ui.range.addEventListener("change", render);
ui["device-picker"].addEventListener("change", event => chooseDevice(devices.get(event.target.value)));
workspace = await createWorkspace({
  connect,
  refresh: () => liveSocket?.readyState === WebSocket.OPEN ? discover(liveSocket) : undefined,
});
new ResizeObserver(render).observe(ui.chart);
setInterval(render, 200);
// Permission and registration changes can originate in another dashboard.
setInterval(() => {
  if (liveSocket?.readyState === WebSocket.OPEN && !eventsDuringDiscovery) discover(liveSocket);
}, 5000);
workspace.open();
