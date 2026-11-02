"""QuestDB OHLC proxy and chart page."""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

QUESTDB_URL = os.environ.get("QUESTDB_URL", "http://172.172.1.13:9000").rstrip("/")
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

OHLC_COLUMNS = {"date", "open", "high", "low", "close", "volume"}
INTERVALS = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1h": "1h",
    "1d": "1d",
}
TABLE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
EXPIRY_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MIN_EXPIRY = "2000-01-01"

app = FastAPI(title="QuestDB OHLC Chart")


async def questdb(sql: str) -> dict:
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.get(f"{QUESTDB_URL}/exec", params={"query": sql})
    if response.status_code != 200:
        detail = response.text
        try:
            detail = response.json().get("error", detail)
        except Exception:
            pass
        raise HTTPException(status_code=502, detail=f"QuestDB error: {detail}")
    payload = response.json()
    if "error" in payload:
        raise HTTPException(status_code=502, detail=f"QuestDB error: {payload['error']}")
    return payload


def rows(payload: dict) -> list[dict]:
    names = [column["name"] for column in payload.get("columns", [])]
    return [dict(zip(names, row)) for row in payload.get("dataset", [])]


def require_table(name: str) -> str:
    if not TABLE_NAME.fullmatch(name or ""):
        raise HTTPException(status_code=400, detail="Invalid table name")
    return name


def format_strike(strike: float) -> str:
    text = format(float(strike), "f").rstrip("0").rstrip(".")
    if not re.fullmatch(r"-?\d+(\.\d+)?", text or ""):
        raise HTTPException(status_code=400, detail="Invalid strike")
    return text


def parse_expiry(value: str | None, required: bool) -> str | None:
    if not value:
        if required:
            raise HTTPException(status_code=400, detail="expiry is required")
        return None
    if not EXPIRY_DATE.fullmatch(value) or value < MIN_EXPIRY:
        raise HTTPException(status_code=400, detail="Invalid expiry")
    return value


def expiry_date(value: str) -> str:
    """QuestDB returns DATE values as ISO timestamps; keep the calendar date."""
    return value[:10]


def unix_seconds(value: str) -> int:
    """Treat the stored timestamp as wall-clock UTC so 09:15 stays 09:15."""
    text = value.replace("Z", "+00:00")
    if "." in text:
        head, tail = text.split(".", 1)
        fraction = tail
        tz = ""
        for mark in ("+", "-"):
            if mark in fraction:
                fraction, tz = fraction.split(mark, 1)
                tz = mark + tz
                break
        fraction = (fraction + "000000")[:6]
        text = f"{head}.{fraction}{tz or '+00:00'}"
    moment = datetime.fromisoformat(text)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return int(moment.timestamp())


async def column_names(table: str) -> set[str]:
    payload = await questdb(f"SHOW COLUMNS FROM {table}")
    return {row["column"] for row in rows(payload)}


async def table_kind(table: str) -> str | None:
    columns = await column_names(table)
    if not OHLC_COLUMNS.issubset(columns):
        return None
    if {"strike", "instrument_type", "expiry"}.issubset(columns):
        return "options"
    if "expiry" in columns:
        return "futures"
    return "spot"


async def require_kind(table: str) -> str:
    require_table(table)
    kind = await table_kind(table)
    if kind is None:
        raise HTTPException(status_code=404, detail="Table is not an OHLC series")
    return kind


@app.get("/api/tables")
async def list_tables() -> dict:
    payload = await questdb("SHOW TABLES")
    tables = []
    for row in rows(payload):
        name = row["table_name"]
        if not TABLE_NAME.fullmatch(name):
            continue
        kind = await table_kind(name)
        if kind is None:
            continue
        tables.append({"name": name, "kind": kind})
    tables.sort(key=lambda item: (item["kind"], item["name"]))
    return {"tables": tables}


@app.get("/api/filters")
async def filters(
    table: str = Query(...),
    expiry: str | None = Query(None),
    instrument_type: str | None = Query(None),
) -> dict:
    kind = await require_kind(table)
    result: dict = {"kind": kind, "expiries": [], "strikes": [], "instrument_types": []}
    if kind == "spot":
        return result

    expiry_rows = await questdb(
        f"SELECT DISTINCT expiry FROM {table} "
        f"WHERE expiry >= '{MIN_EXPIRY}' ORDER BY expiry DESC"
    )
    result["expiries"] = [expiry_date(row["expiry"]) for row in rows(expiry_rows)]

    if kind == "futures":
        return result

    result["instrument_types"] = ["CE", "PE"]
    chosen_expiry = parse_expiry(expiry, required=False)
    if instrument_type is not None and instrument_type not in ("CE", "PE"):
        raise HTTPException(status_code=400, detail="instrument_type must be CE or PE")
    if chosen_expiry and instrument_type:
        strike_rows = await questdb(
            "SELECT DISTINCT strike FROM "
            f"{table} WHERE expiry = '{chosen_expiry}' "
            f"AND instrument_type = '{instrument_type}' ORDER BY strike"
        )
        result["strikes"] = [row["strike"] for row in rows(strike_rows)]
    return result


@app.get("/api/ohlc")
async def ohlc(
    table: str = Query(...),
    interval: str = Query(...),
    expiry: str | None = Query(None),
    strike: float | None = Query(None),
    instrument_type: str | None = Query(None),
) -> dict:
    kind = await require_kind(table)
    if interval not in INTERVALS:
        raise HTTPException(status_code=400, detail="Invalid interval")

    where = []
    if kind == "futures":
        chosen = parse_expiry(expiry, required=True)
        where.append(f"expiry = '{chosen}'")
    elif kind == "options":
        chosen = parse_expiry(expiry, required=True)
        if instrument_type not in ("CE", "PE"):
            raise HTTPException(status_code=400, detail="instrument_type must be CE or PE")
        if strike is None:
            raise HTTPException(status_code=400, detail="strike is required")
        where.append(f"expiry = '{chosen}'")
        where.append(f"strike = {format_strike(strike)}")
        where.append(f"instrument_type = '{instrument_type}'")

    sql = (
        "SELECT date, first(open) AS open, max(high) AS high, min(low) AS low, "
        "last(close) AS close, sum(volume) AS volume "
        f"FROM {table}"
    )
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += f" SAMPLE BY {INTERVALS[interval]} ALIGN TO CALENDAR"

    payload = await questdb(sql)
    candles = []
    for row in rows(payload):
        if row["open"] is None or row["high"] is None or row["low"] is None or row["close"] is None:
            continue
        candles.append(
            {
                "time": unix_seconds(row["date"]),
                "open": row["open"],
                "high": row["high"],
                "low": row["low"],
                "close": row["close"],
                "volume": row["volume"] or 0,
            }
        )
    return {
        "table": table,
        "kind": kind,
        "interval": interval,
        "count": len(candles),
        "from": candles[0]["time"] if candles else None,
        "to": candles[-1]["time"] if candles else None,
        "candles": candles,
    }


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
