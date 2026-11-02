const tableSelect = document.querySelector("#table");
const intervalSelect = document.querySelector("#interval");
const expiryLabel = document.querySelector("#expiry-label");
const expirySelect = document.querySelector("#expiry");
const typeLabel = document.querySelector("#type-label");
const typeSelect = document.querySelector("#instrument-type");
const strikeLabel = document.querySelector("#strike-label");
const strikeSelect = document.querySelector("#strike");
const statusEl = document.querySelector("#status");
const chartEl = document.querySelector("#chart");

const KIND_LABEL = { spot: "Spot", futures: "Futures", options: "Options" };
let tables = [];
let currentKind = "spot";
let loadToken = 0;

const chart = LightweightCharts.createChart(chartEl, {
  autoSize: true,
  layout: {
    background: { type: "solid", color: "#0e1116" },
    textColor: "#d1d4dc",
  },
  grid: {
    vertLines: { color: "#1f2430" },
    horzLines: { color: "#1f2430" },
  },
  rightPriceScale: { borderColor: "#2a3140" },
  timeScale: {
    borderColor: "#2a3140",
    timeVisible: true,
    secondsVisible: false,
    tickMarkFormatter: (time, tickMarkType) => formatTick(time, tickMarkType),
  },
  localization: {
    timeFormatter: (time) => formatExchange(time),
  },
});

const candles = chart.addSeries(LightweightCharts.CandlestickSeries, {
  upColor: "#26a69a",
  downColor: "#ef5350",
  borderVisible: false,
  wickUpColor: "#26a69a",
  wickDownColor: "#ef5350",
});

const volume = chart.addSeries(LightweightCharts.HistogramSeries, {
  priceFormat: { type: "volume" },
  priceScaleId: "volume",
});

candles.priceScale().applyOptions({
  scaleMargins: { top: 0.05, bottom: 0.28 },
});
volume.priceScale().applyOptions({
  scaleMargins: { top: 0.78, bottom: 0 },
});

function pad(value) {
  return String(value).padStart(2, "0");
}

function utcParts(time) {
  const date = new Date(time * 1000);
  return {
    year: date.getUTCFullYear(),
    month: pad(date.getUTCMonth() + 1),
    day: pad(date.getUTCDate()),
    hour: pad(date.getUTCHours()),
    minute: pad(date.getUTCMinutes()),
  };
}

function formatExchange(time) {
  const parts = utcParts(time);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function formatTick(time, tickMarkType) {
  const parts = utcParts(time);
  if (tickMarkType <= 2) {
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  return `${parts.hour}:${parts.minute}`;
}

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", Boolean(isError));
}

function fillSelect(select, values, labelOf) {
  select.replaceChildren();
  for (const value of values) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = labelOf ? labelOf(value) : String(value);
    select.appendChild(option);
  }
}

function showContractControls(kind) {
  currentKind = kind;
  const isFutures = kind === "futures";
  const isOptions = kind === "options";
  expiryLabel.hidden = !(isFutures || isOptions);
  typeLabel.hidden = !isOptions;
  strikeLabel.hidden = !isOptions;
}

async function loadTables() {
  const response = await fetch("/api/tables");
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const payload = await response.json();
  tables = payload.tables;
  tableSelect.replaceChildren();
  for (const kind of ["spot", "futures", "options"]) {
    const groupTables = tables.filter((item) => item.kind === kind);
    if (!groupTables.length) continue;
    const group = document.createElement("optgroup");
    group.label = KIND_LABEL[kind];
    for (const item of groupTables) {
      const option = document.createElement("option");
      option.value = item.name;
      option.textContent = item.name;
      option.dataset.kind = item.kind;
      group.appendChild(option);
    }
    tableSelect.appendChild(group);
  }
  const nifty = tables.find((item) => item.name === "nse_nifty_50");
  if (nifty) tableSelect.value = nifty.name;
}

async function loadFilters() {
  const table = tableSelect.value;
  const kind = tables.find((item) => item.name === table)?.kind || "spot";
  showContractControls(kind);
  if (kind === "spot") return;

  const params = new URLSearchParams({ table });
  if (kind === "options") params.set("instrument_type", typeSelect.value);
  if (expirySelect.value && kind === "options") params.set("expiry", expirySelect.value);

  const response = await fetch(`/api/filters?${params}`);
  if (!response.ok) throw new Error(await response.text());
  const payload = await response.json();

  const previousExpiry = expirySelect.value;
  fillSelect(expirySelect, payload.expiries);
  if (payload.expiries.includes(previousExpiry)) expirySelect.value = previousExpiry;

  if (kind !== "options") return;

  const strikeParams = new URLSearchParams({
    table,
    expiry: expirySelect.value,
    instrument_type: typeSelect.value,
  });
  const strikeResponse = await fetch(`/api/filters?${strikeParams}`);
  if (!strikeResponse.ok) throw new Error(await strikeResponse.text());
  const withStrikes = await strikeResponse.json();
  const previousStrike = strikeSelect.value;
  fillSelect(strikeSelect, withStrikes.strikes, (strike) => String(strike));
  if (withStrikes.strikes.map(String).includes(previousStrike)) {
    strikeSelect.value = previousStrike;
  } else if (withStrikes.strikes.length) {
    strikeSelect.selectedIndex = Math.floor(withStrikes.strikes.length / 2);
  }
}

function contractReady() {
  if (currentKind === "spot") return true;
  if (!expirySelect.value) return false;
  if (currentKind === "options" && !strikeSelect.value) return false;
  return true;
}

async function loadChart() {
  const token = ++loadToken;
  if (!tableSelect.value || !contractReady()) {
    candles.setData([]);
    volume.setData([]);
    setStatus("Choose a contract to plot.");
    return;
  }

  setStatus("Loading candles…");
  const params = new URLSearchParams({
    table: tableSelect.value,
    interval: intervalSelect.value,
  });
  if (currentKind !== "spot") params.set("expiry", expirySelect.value);
  if (currentKind === "options") {
    params.set("instrument_type", typeSelect.value);
    params.set("strike", strikeSelect.value);
  }

  const response = await fetch(`/api/ohlc?${params}`);
  if (token !== loadToken) return;
  if (!response.ok) {
    const detail = await response.text();
    if (token !== loadToken) return;
    setStatus(detail, true);
    return;
  }
  const payload = await response.json();
  if (token !== loadToken) return;

  candles.setData(
    payload.candles.map((bar) => ({
      time: bar.time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    }))
  );
  volume.setData(
    payload.candles.map((bar) => ({
      time: bar.time,
      value: bar.volume,
      color: bar.close >= bar.open ? "rgba(38, 166, 154, 0.45)" : "rgba(239, 83, 80, 0.45)",
    }))
  );
  chart.timeScale().fitContent();

  if (!payload.count) {
    setStatus("No bars for this selection.");
    return;
  }
  const from = formatExchange(payload.from);
  const to = formatExchange(payload.to);
  setStatus(`${payload.count.toLocaleString()} bars · ${from} → ${to}`);
}

async function refresh() {
  try {
    await loadFilters();
    await loadChart();
  } catch (error) {
    setStatus(error.message || "Request failed", true);
  }
}

tableSelect.addEventListener("change", refresh);
intervalSelect.addEventListener("change", () => {
  loadChart().catch((error) => setStatus(error.message || "Request failed", true));
});
expirySelect.addEventListener("change", refresh);
typeSelect.addEventListener("change", refresh);
strikeSelect.addEventListener("change", () => {
  loadChart().catch((error) => setStatus(error.message || "Request failed", true));
});

loadTables()
  .then(refresh)
  .catch((error) => setStatus(error.message || "Could not load tables", true));
