# QuestDB OHLC Chart

A local web app that reads minute OHLC from [QuestDB](https://questdb.io/) and draws candlesticks with volume. The browser never talks to QuestDB directly. FastAPI lists chartable tables, loads contract filters, resamples the series, and serves the chart page.

Stored timestamps are exchange wall-clock labeled as UTC. `09:15:00.000Z` is the session open. The chart plots those values as-is, so candles stay on 09:15 instead of shifting into another timezone.

## What it charts

A table is chartable only when it has `date`, `open`, `high`, `low`, `close`, and `volume`. Other tables are skipped. Daily dumps such as `nfo_bhavcopy` use different column names (`OpnPric`, `TradDt`) and are not treated as a minute OHLC series.

| Kind | How it is detected | Extra columns | What one chart is |
| --- | --- | --- | --- |
| Spot | OHLC columns, no `expiry` | — | The whole series (indexes, India VIX) |
| Futures | OHLC columns plus `expiry` | `expiry`, often `expiry_rank` | One expiry. Mixing expiries would blend different contracts. |
| Options | OHLC columns plus `expiry`, `strike`, and `instrument_type` | `expiry` (DATE), `strike` (DOUBLE), `instrument_type` (`CE` or `PE`) | One expiry + strike + call or put |

Examples of each kind:

- **Spot / index:** `nse_nifty_50`, `nse_banknifty`, `bse_sensex`, `india_vix`. Nifty is on the order of 1.1 million 1-minute bars from 2015-01-09 through 2026-10-30.
- **Futures:** table names ending in `_futures`, plus MCX series that share the same columns.
- **Options:** `nfo_nifty_options`, `nfo_banknifty_options`, `bfo_sensex_options`.

Some option rows store epoch junk such as `1970-01-01`. Expiry lists keep only dates on or after `2000-01-01`.

## How it fits together

```
Browser  -- table, filters, interval -->  FastAPI
FastAPI  -- whitelisted SQL /exec     -->  QuestDB :9000
QuestDB  -- OHLC rows                 -->  FastAPI
FastAPI  -- candles {time, ohlc, vol} -->  Browser (Lightweight Charts)
```

Resampling happens in QuestDB with `SAMPLE BY ... ALIGN TO CALENDAR`. A 15-minute Nifty spot query looks like this:

```sql
SELECT date, first(open) AS open, max(high) AS high, min(low) AS low,
       last(close) AS close, sum(volume) AS volume
FROM nse_nifty_50
SAMPLE BY 15m ALIGN TO CALENDAR
```

`first(open)` and `last(close)` keep the bar's open and close. `max(high)` and `min(low)` span the bar. `sum(volume)` adds the underlying minutes. Empty buckets (null OHLC) are dropped before the response is sent.

Allowed intervals are fixed: `1m`, `5m`, `15m`, `30m`, `1h`, `1d`. The default on the page is `15m`.

## Requirements

- Python 3.10 or newer (the app uses `str | None` type hints)
- A QuestDB HTTP endpoint that answers `GET /exec`
- A browser with network access to the chart library on unpkg

Python packages are pinned in `requirements.txt`:

- `fastapi==0.115.6`
- `uvicorn==0.34.0`
- `httpx==0.28.1`

The page loads TradingView Lightweight Charts `5.0.9` from `https://unpkg.com/lightweight-charts@5.0.9/dist/lightweight-charts.standalone.production.js`. That request needs internet access the first time the page loads, unless the script is already cached.

## Setup

From the project root:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

On macOS or Linux, activate with `source .venv/bin/activate` instead.

QuestDB defaults to `http://172.172.1.13:9000`. Point the app at another host by setting `QUESTDB_URL` (no trailing path; `/exec` is appended):

```powershell
$env:QUESTDB_URL = "http://127.0.0.1:9000"
```

## Run

```powershell
uvicorn app.main:app --reload
```

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000).

`--reload` restarts the server when Python files change. Static files (`static/`) are read from disk on each request, so HTML, CSS, and JS edits show up on refresh without a restart.

A useful first check against a populated QuestDB:

1. Nifty spot (`nse_nifty_50`) at 15m.
2. One Nifty futures expiry.
3. One Nifty option: expiry + strike + CE.

The first bar of a cash session should sit at 09:15. The status line under the toolbar reports the bar count and the query range, for example `12,345 bars · 2015-01-09 09:15 → 2026-10-30 15:30`.

## Using the chart

Controls live in the top toolbar. Changing any of them replaces the series.

- **Table.** Grouped into Spot, Futures, and Options. If `nse_nifty_50` exists, it is selected on load.
- **Timeframe.** `1m` through `1d`. Changing timeframe reloads candles only; contract dropdowns stay as they are.
- **Expiry.** Shown for futures and options, newest first. Required before a chart is drawn.
- **Type.** Options only. `CE` or `PE`. Changing it reloads the strike list for that expiry.
- **Strike.** Options only. Loaded after expiry and type are set. The chart waits until all three are chosen. When the previous strike is not in the new list, the middle strike is selected.

The candlestick series uses the main price scale. Volume is a histogram on its own scale along the bottom of the pane. Up bars are teal and down bars are red. Crosshair and axis labels use the stored wall-clock time, not the browser's local timezone.

Pan and zoom with the mouse. The time scale fits the full result after each load. Large histories (especially `1m` on a multi-year index) return the whole resampled series in one response, so the first paint can take a few seconds. QuestDB calls time out after 120 seconds.

## API

All query parameters are validated before they are placed in SQL. Table names must match `^[A-Za-z_][A-Za-z0-9_]*$` and must be a chartable OHLC table. `instrument_type` is only `CE` or `PE`. Expiry must be `YYYY-MM-DD` and on or after `2000-01-01`. Strike must be a finite number. Intervals must be one of the six whitelist values. Anything else returns HTTP 400. QuestDB failures return HTTP 502 with the database error text.

### `GET /api/tables`

Runs `SHOW TABLES`, then `SHOW COLUMNS` for each name that looks like a table. Tables missing the OHLC columns are omitted.

```json
{
  "tables": [
    { "name": "nse_nifty_50", "kind": "spot" },
    { "name": "nse_nifty_futures", "kind": "futures" },
    { "name": "nfo_nifty_options", "kind": "options" }
  ]
}
```

Results are sorted by kind, then by name.

### `GET /api/filters`

| Query | Required | Meaning |
| --- | --- | --- |
| `table` | yes | Chartable table name |
| `expiry` | no | `YYYY-MM-DD`. Used with `instrument_type` to list strikes. |
| `instrument_type` | no | `CE` or `PE` |

Spot returns empty filter lists. Futures returns `expiries` (newest first). Options also returns `instrument_types: ["CE", "PE"]`. Strikes are filled only when both `expiry` and `instrument_type` are present, so the list is one contract chain instead of every strike in the table.

```json
{
  "kind": "options",
  "expiries": ["2026-10-28", "2026-10-21"],
  "strikes": [24000, 24050, 24100],
  "instrument_types": ["CE", "PE"]
}
```

### `GET /api/ohlc`

| Query | Required | Meaning |
| --- | --- | --- |
| `table` | yes | Chartable table name |
| `interval` | yes | `1m`, `5m`, `15m`, `30m`, `1h`, or `1d` |
| `expiry` | futures and options | `YYYY-MM-DD` |
| `strike` | options | Numeric strike |
| `instrument_type` | options | `CE` or `PE` |

Spot has no contract filter. Futures filters with `expiry = '...'`. Options filters with `expiry`, `strike`, and `instrument_type`.

`time` is Unix seconds. `from` and `to` are the first and last candle times, or `null` when nothing matched.

```json
{
  "table": "nse_nifty_50",
  "kind": "spot",
  "interval": "15m",
  "count": 1,
  "from": 1420794900,
  "to": 1420794900,
  "candles": [
    {
      "time": 1420794900,
      "open": 8283.5,
      "high": 8292.0,
      "low": 8275.1,
      "close": 8288.4,
      "volume": 0
    }
  ]
}
```

Null `volume` is returned as `0`.

## Project layout

```
app/main.py          FastAPI routes, QuestDB client, SQL whitelist
static/index.html    Toolbar and chart container
static/app.js        Filters, fetches, Lightweight Charts series
static/style.css     Dark layout for the toolbar and chart pane
requirements.txt     Pinned Python dependencies
```

`app/main.py` mounts `static/` at `/` after the `/api` routes, with `html=True`, so `/` serves `index.html`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `QUESTDB_URL` | `http://172.172.1.13:9000` | QuestDB HTTP base URL. Trailing slashes are stripped. Queries go to `{QUESTDB_URL}/exec`. |

There is no authentication in this app. It is meant for a trusted network where QuestDB is already reachable. Do not expose the FastAPI port to the public internet without adding your own access control; the API can read every chartable table on the configured database.
