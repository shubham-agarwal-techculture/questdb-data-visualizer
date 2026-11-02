const tableSelect = document.querySelector("#table");
const intervalSelect = document.querySelector("#interval");
const dayInput = document.querySelector("#day");
const expiryLabel = document.querySelector("#expiry-label");
const expirySelect = document.querySelector("#expiry");
const typeLabel = document.querySelector("#type-label");
const typeSelect = document.querySelector("#instrument-type");
const strikeLabel = document.querySelector("#strike-label");
const strikeSelect = document.querySelector("#strike");
const statusEl = document.querySelector("#status");
const clearRangeButton = document.querySelector("#clear-range");
const chartEl = document.querySelector("#chart");

const KIND_LABEL = { spot: "Spot", futures: "Futures", options: "Options" };
let tables = [];
let currentKind = "spot";
let loadToken = 0;
let bars = [];
let baseStatus = "";
let rangeStart = null;
let rangeEnd = null;
let chartLoading = false;

const rangeHighlight = {
  _from: null,
  _to: null,
  _chart: null,
  _requestUpdate: null,
  _x1: null,
  _x2: null,
  attached(param) {
    this._chart = param.chart;
    this._requestUpdate = param.requestUpdate;
  },
  detached() {
    this._chart = null;
    this._requestUpdate = null;
  },
  setRange(from, to) {
    this._from = from;
    this._to = to;
    if (this._requestUpdate) this._requestUpdate();
  },
  updateAllViews() {
    this._x1 = null;
    this._x2 = null;
    if (!this._chart || this._from == null || this._to == null) return;
    const scale = this._chart.timeScale();
    const xLeft = scale.logicalToCoordinate(Math.min(this._from, this._to));
    const xRight = scale.logicalToCoordinate(Math.max(this._from, this._to));
    if (xLeft == null || xRight == null) return;
    const half = scale.options().barSpacing / 2;
    this._x1 = xLeft - half;
    this._x2 = xRight + half;
  },
  paneViews() {
    const source = this;
    return [
      {
        zOrder() {
          return "bottom";
        },
        renderer() {
          return {
            draw(target) {
              if (source._x1 == null || source._x2 == null) return;
              target.useBitmapCoordinateSpace((scope) => {
                const ctx = scope.context;
                const horizontal = scope.horizontalPixelRatio;
                const x = Math.round(Math.min(source._x1, source._x2) * horizontal);
                const width = Math.max(1, Math.round(Math.abs(source._x2 - source._x1) * horizontal));
                ctx.fillStyle = "rgba(66, 133, 244, 0.2)";
                ctx.fillRect(x, 0, width, scope.bitmapSize.height);
                ctx.fillStyle = "rgba(144, 180, 255, 0.95)";
                const edge = Math.max(1, Math.round(horizontal));
                ctx.fillRect(x, 0, edge, scope.bitmapSize.height);
                ctx.fillRect(x + width - edge, 0, edge, scope.bitmapSize.height);
              });
            },
          };
        },
      },
    ];
  },
};

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

candles.attachPrimitive(rangeHighlight);

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

function barDay(time) {
  const parts = utcParts(time);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dayBounds(day) {
  let first = -1;
  let last = -1;
  for (let index = 0; index < bars.length; index += 1) {
    if (barDay(bars[index].time) !== day) continue;
    if (first < 0) first = index;
    last = index;
  }
  return { first, last };
}

function applyDayView() {
  if (!bars.length) return;
  const total = `${bars.length.toLocaleString()} bars · ${formatExchange(bars[0].time)} → ${formatExchange(bars[bars.length - 1].time)}`;
  const day = dayInput.value;
  if (!day) {
    chart.timeScale().fitContent();
    baseStatus = total;
    renderStatus();
    return;
  }
  const { first, last } = dayBounds(day);
  if (first < 0) {
    chart.timeScale().fitContent();
    baseStatus = `${total} · no bars on ${day}`;
    renderStatus();
    return;
  }
  chart.timeScale().setVisibleLogicalRange({
    from: first - 0.5,
    to: last + 0.5,
  });
  baseStatus = `${total} · showing ${formatExchange(bars[first].time)} → ${formatExchange(bars[last].time)}`;
  renderStatus();
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

function updateClearButton() {
  clearRangeButton.disabled = rangeStart == null;
}

function clearRange() {
  rangeStart = null;
  rangeEnd = null;
  rangeHighlight.setRange(null, null);
  updateClearButton();
}

function deleteRange() {
  if (rangeStart == null) return;
  clearRange();
  renderStatus();
}

function renderStatus() {
  if (rangeStart == null || !bars.length) {
    setStatus(baseStatus);
    return;
  }
  const from = rangeEnd == null ? rangeStart : Math.min(rangeStart, rangeEnd);
  const to = rangeEnd == null ? rangeStart : Math.max(rangeStart, rangeEnd);
  const start = formatExchange(bars[from].time);
  const end = formatExchange(bars[to].time);
  if (rangeEnd == null) {
    setStatus(`${baseStatus} · start ${start} · click the end candle`);
    return;
  }
  const count = to - from + 1;
  setStatus(`${baseStatus} · ${count.toLocaleString()} selected · ${start} → ${end}`);
}

function barIndexAt(param) {
  if (!bars.length || typeof param.logical !== "number" || !Number.isFinite(param.logical)) {
    return null;
  }
  const index = Math.round(param.logical);
  if (index < 0 || index >= bars.length) return null;
  return index;
}

function selectCandle(index) {
  if (rangeStart == null || rangeEnd != null) {
    rangeStart = index;
    rangeEnd = null;
  } else {
    rangeEnd = index;
  }
  const from = rangeEnd == null ? rangeStart : Math.min(rangeStart, rangeEnd);
  const to = rangeEnd == null ? rangeStart : Math.max(rangeStart, rangeEnd);
  rangeHighlight.setRange(from, to);
  updateClearButton();
  renderStatus();
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
  chartLoading = true;
  clearRange();
  try {
    if (!tableSelect.value || !contractReady()) {
      bars = [];
      baseStatus = "";
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

    bars = payload.candles;
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
    if (!payload.count) {
      baseStatus = "No bars for this selection.";
      setStatus(baseStatus);
      return;
    }
    applyDayView();
  } finally {
    if (token === loadToken) chartLoading = false;
  }
}

async function refresh() {
  try {
    await loadFilters();
    await loadChart();
  } catch (error) {
    setStatus(error.message || "Request failed", true);
  }
}

clearRangeButton.addEventListener("click", deleteRange);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Delete" && event.key !== "Escape") return;
  const tag = event.target && event.target.tagName;
  if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") return;
  if (rangeStart == null) return;
  event.preventDefault();
  deleteRange();
});

chart.subscribeClick((param) => {
  if (chartLoading) return;
  const index = barIndexAt(param);
  if (index == null) return;
  selectCandle(index);
});

tableSelect.addEventListener("change", refresh);
intervalSelect.addEventListener("change", () => {
  loadChart().catch((error) => setStatus(error.message || "Request failed", true));
});
dayInput.addEventListener("change", () => {
  if (chartLoading || !bars.length) {
    loadChart().catch((error) => setStatus(error.message || "Request failed", true));
    return;
  }
  applyDayView();
});
expirySelect.addEventListener("change", refresh);
typeSelect.addEventListener("change", refresh);
strikeSelect.addEventListener("change", () => {
  loadChart().catch((error) => setStatus(error.message || "Request failed", true));
});

loadTables()
  .then(refresh)
  .catch((error) => setStatus(error.message || "Could not load tables", true));
