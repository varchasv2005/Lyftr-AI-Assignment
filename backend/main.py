"""SARA API: SQLite-backed chat with LiteLLM key failover and caching."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import litellm
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator


DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:////data/app.db")
DB_PATH = DATABASE_URL.removeprefix("sqlite:////")
if not DB_PATH.startswith("/"):
    DB_PATH = "/" + DB_PATH
KEYS = [key.strip() for key in os.getenv("LLM_API_KEYS", "").split(",") if key.strip()]
MODEL = os.getenv("LLM_MODEL", "gemini/gemini-2.0-flash")
DEFAULT_SYSTEM_PROMPT = os.getenv(
    "DEFAULT_SYSTEM_PROMPT",
    "You are SARA (Smart Adaptive Response Assistant), a helpful, clear, and thoughtful AI assistant.",
)
CACHE_ENABLED = os.getenv("CACHE_ENABLED", "true").lower() == "true"
SIMULATION_ENABLED = os.getenv("ENABLE_FAILURE_SIMULATION", "false").lower() == "true"

if CACHE_ENABLED:
    # LiteLLM's local cache is process-local and needs no Redis or external service.
    litellm.cache = litellm.Cache(type="local")
    litellm.enable_cache()
litellm.num_retries = 0
litellm.telemetry = False


def connect() -> sqlite3.Connection:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=20)
    db.row_factory = sqlite3.Row
    return db


def initialize_db() -> None:
    with connect() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            metadata TEXT,
            created_at TEXT NOT NULL
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS idx_messages_session_id_id ON messages(session_id, id)")


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_db()
    yield


app = FastAPI(title="SARA API", version="1.0.0", lifespan=lifespan)
origins = [origin.strip() for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-Simulate-Failure"],
)


class ChatRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1, max_length=4000)
    system_prompt: str | None = Field(default=None, max_length=4000)

    @field_validator("session_id")
    @classmethod
    def session_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("session_id cannot be empty")
        return value

    @field_validator("message")
    @classmethod
    def message_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("message cannot be empty")
        return value


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def simulation_map(header: str | None) -> dict[str, int]:
    if not SIMULATION_ENABLED or not header:
        return {}
    failures: dict[str, int] = {}
    for part in header.split(","):
        match = re.fullmatch(r"\s*(key_\d+|\*)\s*=\s*(429|500|502|503)\s*", part)
        if match:
            failures[match.group(1)] = int(match.group(2))
    return failures


def is_cache_hit(response: Any) -> bool:
    hidden = getattr(response, "_hidden_params", {}) or {}
    return bool(hidden.get("cache_hit"))


def usage_value(usage: Any, key: str) -> int:
    value = getattr(usage, key, None) if usage is not None else None
    if value is None and isinstance(usage, dict):
        value = usage.get(key)
    return int(value or 0)


@app.get("/health")
def health() -> dict[str, Any]:
    if len(KEYS) < 2:
        raise HTTPException(status_code=503, detail="at least two provider keys are required")
    try:
        with connect() as db:
            db.execute("SELECT 1").fetchone()
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail="database unavailable") from exc
    return {"status": "ok", "keys_configured": len(KEYS), "cache_enabled": CACHE_ENABLED}


@app.post("/chat")
def chat(payload: ChatRequest, x_simulate_failure: str | None = Header(default=None)) -> dict[str, Any]:
    if not KEYS:
        raise HTTPException(status_code=503, detail="all providers unavailable")

    start = time.perf_counter()
    with connect() as db:
        rows = db.execute(
            "SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC",
            (payload.session_id,),
        ).fetchall()
    system_prompt = (payload.system_prompt or DEFAULT_SYSTEM_PROMPT).strip() or DEFAULT_SYSTEM_PROMPT
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend({"role": row["role"], "content": row["content"]} for row in rows)
    messages.append({"role": "user", "content": payload.message})

    failures = simulation_map(x_simulate_failure)
    attempts = 0
    final_response: Any = None
    successful_key_id: str | None = None
    for index, key in enumerate(KEYS, start=1):
        key_id = f"key_{index}"
        simulated_status = failures.get("*", failures.get(key_id))
        if simulated_status:
            attempts += 1
            continue
        try:
            final_response = litellm.completion(
                model=MODEL,
                messages=messages,
                api_key=key,
                drop_params=True,
                timeout=float(os.getenv("LLM_TIMEOUT_SECONDS", "30")),
            )
            successful_key_id = key_id
            break
        except Exception as exc:
            # Fail over only for transient/provider availability failures.
            status = getattr(exc, "status_code", None)
            transient = status in {429, 500, 502, 503, 504} or any(
                marker in str(exc).lower()
                for marker in ("quota", "rate limit", "temporarily", "unavailable", "internal server")
            )
            if transient:
                attempts += 1
                continue
            raise HTTPException(status_code=503, detail="all providers unavailable") from exc

    if final_response is None:
        raise HTTPException(status_code=503, detail="all providers unavailable")

    try:
        reply = (final_response.choices[0].message.content or "").strip()
    except (AttributeError, IndexError, TypeError):
        reply = ""
    if not reply:
        raise HTTPException(status_code=503, detail="all providers unavailable")

    cache_hit = is_cache_hit(final_response)
    usage = getattr(final_response, "usage", None)
    metadata = {
        "resolution_source": "LLM_CACHE" if cache_hit else "LIVE_INFERENCE",
        "model": MODEL,
        "latency_ms": max(0, int((time.perf_counter() - start) * 1000)),
        "input_tokens": usage_value(usage, "prompt_tokens"),
        "output_tokens": usage_value(usage, "completion_tokens"),
        "key_id": None if cache_hit else successful_key_id,
        "fallback_attempts": 0 if cache_hit else attempts,
    }
    created = now_iso()
    with connect() as db:
        db.execute(
            "INSERT INTO messages(session_id, role, content, metadata, created_at) VALUES (?, 'user', ?, NULL, ?)",
            (payload.session_id, payload.message, created),
        )
        db.execute(
            "INSERT INTO messages(session_id, role, content, metadata, created_at) VALUES (?, 'assistant', ?, ?, ?)",
            (payload.session_id, reply, json.dumps(metadata), now_iso()),
        )
    return {"session_id": payload.session_id, "reply": reply, "metadata": metadata}


@app.get("/sessions/{session_id}/messages")
def get_messages(session_id: str) -> dict[str, Any]:
    if not session_id.strip() or len(session_id) > 128:
        raise HTTPException(status_code=422, detail="invalid session_id")
    with connect() as db:
        rows = db.execute(
            "SELECT role, content, metadata FROM messages WHERE session_id = ? ORDER BY id ASC",
            (session_id,),
        ).fetchall()
    if not rows:
        raise HTTPException(status_code=404, detail="session not found")
    messages = []
    for row in rows:
        item: dict[str, Any] = {"role": row["role"], "content": row["content"]}
        if row["metadata"]:
            item["metadata"] = json.loads(row["metadata"])
        messages.append(item)
    return {"session_id": session_id, "messages": messages}
