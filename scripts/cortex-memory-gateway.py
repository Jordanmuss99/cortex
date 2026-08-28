#!/usr/bin/env python3
"""
CORTEX MEMORY GATEWAY -- Deterministic recall-inject + capture proxy.

Sits between Hermes Agent (or any OpenAI-compatible client) and the real
model provider.  Every request gets:

  PRE  (deterministic, no model decision):
    1. Extract the latest user turn.
    2. Cortex REST /recall  (CA3-enabled, token-budgeted).
    3. Inject as a memory block AFTER the stable system prefix
       (KV-cache-aware), throttled per task boundary.

  FORWARD -> real provider (Ollama / OpenAI / Anthropic-compatible).

  POST (after model output, before handler completion):
    4. Capture exchange -> durable Cortex /ingest acceptance.
    5. Honor "// VERIFIED" breadcrumbs as requested-priority signals.

Run:
    python gateway.py                         # defaults
    CORTEX_GATEWAY_PORT=3101 python gateway.py # custom port

Config via env (all have safe defaults):
    CORTEX_REST_BASE     http://127.0.0.1:3100
    CORTEX_AGENT_ID      arlo
    CORTEX_RECALL_BUDGET 1200        (tokens of recall per task boundary)
    CORTEX_RECALL_THROTTLE_MS 600000  (10-min window; 0 = every request)
    CORTEX_UPSTREAM      http://127.0.0.1:11434/v1
    CORTEX_GATEWAY_BIND  127.0.0.1
    CORTEX_GATEWAY_PORT  3101
    CORTEX_LOG_LEVEL    INFO

References:
  CORTEX_INTEGRATION_DESIGN.md (Option B -- bespoke gateway)
  CORTEX_VERIFICATION_FINDINGS.md S5 (Meridian coupling -- leave Cortex's
    internal LLM path alone; this gateway is for agent traffic only)
  CORTEX_TECHNICAL_REFERENCE.md §3 (REST recall inherits CA3)

Conventions: -- not em-dashes (repo standing-order; drift check counts them).
"""

from __future__ import annotations

from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable
import hashlib
import json
import logging
import math
import os
import re
import time
import unicodedata
from typing import Any, Optional

import httpx

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CORTEX_REST_BASE = os.getenv("CORTEX_REST_BASE", "http://127.0.0.1:3100").rstrip("/")
CORTEX_AGENT_ID = os.getenv("CORTEX_AGENT_ID", "arlo")
CORTEX_RECALL_BUDGET = int(os.getenv("CORTEX_RECALL_BUDGET", "1200"))
CORTEX_RECALL_THROTTLE_MS = int(os.getenv("CORTEX_RECALL_THROTTLE_MS", "600000"))
CORTEX_UPSTREAM = os.getenv("CORTEX_UPSTREAM", "http://127.0.0.1:11434/v1").rstrip("/")
CORTEX_GATEWAY_BIND = os.getenv("CORTEX_GATEWAY_BIND", "127.0.0.1")
CORTEX_GATEWAY_PORT = int(os.getenv("CORTEX_GATEWAY_PORT", "3101"))
CORTEX_LOG_LEVEL = os.getenv("CORTEX_LOG_LEVEL", "INFO").upper()

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=getattr(logging, CORTEX_LOG_LEVEL, logging.INFO),
    format="%(asctime)s [cortex-gw] %(levelname)s %(message)s",
)
log = logging.getLogger("cortex-gateway")

# ---------------------------------------------------------------------------
# Per-session throttle state
# ---------------------------------------------------------------------------

# Maps a session key -> last-recall timestamp (epoch ms).  A session key is
# derived from the first system message hash or a synthetic id so independent
# conversations get independent windows.  Throttle is per-task-boundary: if the
# last recall for this session was within CORTEX_RECALL_THROTTLE_MS, we skip and
# reuse nothing (the model already has the prior recall in context).
_last_recall_ts: dict[str, float] = {}

# Per-session recall cache: if the query hasn't changed meaningfully, reuse
# the previous recall block instead of hitting Cortex again.
_last_recall_query: dict[str, str] = {}
_last_recall_block: dict[str, str] = {}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Match "// VERIFIED" breadcrumbs anywhere in user content. These request
# elevated priority; Cortex's central ingest policy decides effective priority.
_VERIFIED_RE = re.compile(r"//\s*VERIFIED", re.IGNORECASE)

# A "task boundary" heuristic: if the latest user message is short and
# directive ("ok", "yes", "continue", "go ahead", a lone tool result), we
# don't re-recall -- the task context is already loaded from the prior turn.
_TRIVIAL_TURN_RE = re.compile(
    r"^(ok|okay|yes|y|no|n|continue|go|go ahead|sure|done|thanks|thank you|"
    r"nice|great|cool|yep|nope|pls|please|what\??|hmm|k|kk)\s*[\.\!\?]?\s*$",
    re.IGNORECASE,
)

# Match ECMAScript String.prototype.trim exactly so Python-derived gateway
# keys stay byte-for-byte identical to the TypeScript contract. Python's
# str.strip() differs for U+FEFF and U+0085.
_ECMASCRIPT_TRIM_CHARS = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _canonical_json(value: Any) -> str:
    """Use compact UTF-8 JSON; string-array keys match JSON.stringify exactly."""
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _normalized_identity(value: str) -> str:
    return unicodedata.normalize("NFC", value).strip(_ECMASCRIPT_TRIM_CHARS)


def derive_capture_idempotency_key(
    session_id: str,
    turn_id: str,
    content: str,
) -> str:
    """Derive the same stable gateway key as the TypeScript ingest service."""
    components = [
        "gateway-capture-v1",
        _normalized_identity(session_id),
        _normalized_identity(turn_id),
        _sha256(content),
    ]
    return f"gateway:v1:{_sha256(_canonical_json(components))}"


def _identity_candidate(*values: Any) -> Optional[str]:
    for value in values:
        if isinstance(value, (str, int)):
            normalized = _normalized_identity(str(value))
            if normalized:
                return normalized
    return None


def _header_value(headers: Any, name: str) -> Any:
    value = headers.get(name)
    if value is not None:
        return value
    try:
        for key, candidate in headers.items():
            if str(key).lower() == name:
                return candidate
    except (AttributeError, TypeError):
        pass
    return None


def _bounded_origin_id(kind: str, value: str) -> str:
    normalized = _normalized_identity(value)
    if len(normalized) <= 128:
        return normalized
    return f"{kind}:{_sha256(normalized)}"


def _conversation_lineage(protocol: str, payload: dict) -> tuple[Any, int, Any]:
    """Return stable session seed records plus the latest user turn identity."""
    field = payload.get("messages") if protocol == "chat" else payload.get("input")
    if isinstance(field, str):
        user = {"role": "user", "content": field}
        return ([user], 0, user)
    if not isinstance(field, list):
        return ([], -1, None)
    stable_prefix: list[Any] = []
    first_user_seen = False
    last_user = -1
    last_user_record: Any = None
    for index, item in enumerate(field):
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        if not first_user_seen and role in ("system", "developer"):
            stable_prefix.append(item)
        if role == "user":
            if not first_user_seen:
                stable_prefix.append(item)
                first_user_seen = True
            last_user = index
            last_user_record = item
    return (stable_prefix, last_user, last_user_record)


def derive_capture_lineage(
    protocol: str,
    payload: dict,
    headers: Any,
) -> tuple[str, str]:
    """Resolve caller lineage, with deterministic request-derived fallbacks."""
    metadata = payload.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}

    session_id = _identity_candidate(
        _header_value(headers, "x-cortex-session-id"),
        payload.get("session_id"),
        payload.get("sessionId"),
        payload.get("conversation_id"),
        payload.get("conversationId"),
        metadata.get("session_id"),
        metadata.get("sessionId"),
        metadata.get("conversation_id"),
        metadata.get("conversationId"),
    )
    turn_id = _identity_candidate(
        _header_value(headers, "x-cortex-turn-id"),
        _header_value(headers, "idempotency-key"),
        payload.get("turn_id"),
        payload.get("turnId"),
        payload.get("request_id"),
        payload.get("requestId"),
        metadata.get("turn_id"),
        metadata.get("turnId"),
        metadata.get("request_id"),
        metadata.get("requestId"),
    )

    if session_id is None:
        stable_prefix, _, _ = _conversation_lineage(protocol, payload)
        prefix = [
            "gateway-session-lineage-v1",
            protocol,
            stable_prefix,
        ]
        session_id = f"{protocol}:{_sha256(_canonical_json(prefix))}"
    if turn_id is None:
        _, latest_user_index, latest_user_record = _conversation_lineage(
            protocol,
            payload,
        )
        request_lineage = [
            "gateway-turn-lineage-v1",
            protocol,
            latest_user_index,
            latest_user_record,
        ]
        turn_id = f"{protocol}:{_sha256(_canonical_json(request_lineage))}"

    return (
        _bounded_origin_id("session", session_id),
        _bounded_origin_id("turn", turn_id),
    )


def _extract_latest_user_turn(messages: list[dict]) -> Optional[str]:
    """Return the content of the last user message, or None."""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            # OpenAI format: content can be a string or a list of content parts
            if isinstance(content, list):
                parts = [p.get("text", "") for p in content if isinstance(p, dict)]
                return " ".join(parts).strip() or None
            return str(content).strip() or None
    return None


def _find_inject_point(messages: list[dict]) -> int:
    """Find the index AFTER the last system message (the stable prefix).

    KV-cache constraint: the system+tools prefix must stay stable.  We inject
    the recall block as a NEW system message immediately after the last
    existing system message, so the prefix up to that point remains cacheable.

    If there are no system messages, inject at position 0.
    """
    last_sys = -1
    for i, m in enumerate(messages):
        if m.get("role") == "system":
            last_sys = i
    return last_sys + 1


def _format_recall_block(context: str, query: str) -> str:
    """Format the Cortex recall context into a clean system-message block."""
    if not context or not context.strip():
        return ""
    header = "## CORTEX Memory Recall"
    footer = (
        "## End of Memory Recall\n"
        "Use the above context if relevant. Do not restate it verbatim."
    )
    return f"{header}\nQuery: {query[:200]}\n\n{context.strip()}\n\n{footer}"


# ---------------------------------------------------------------------------
# Cortex REST client
# ---------------------------------------------------------------------------

async def cortex_recall(query: str, budget: int) -> Optional[dict]:
    """Call POST /api/v1/search and return structured results.

    Uses /search (not /recall) so we can inspect individual result scores
    and apply a relevance gate before injecting.  Returns:
      {
        "context": str,       -- formatted context block (or "")
        "results": list,      -- raw search results with scores
        "top_score": float,   -- highest hybrid score
        "memory_count": int,  -- number of memories returned
      }
    """
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{CORTEX_REST_BASE}/api/v1/search",
                json={
                    "query": query,
                    "agentId": CORTEX_AGENT_ID,
                    "limit": 10,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            results = data.get("results", [])
            if not results:
                return {"context": "", "results": [], "top_score": 0.0, "memory_count": 0}

            top_score = results[0].get("score", 0.0)

            # Build a token-budgeted context from the results
            context_parts = ["## Relevant Memories\n"]
            used_tokens = 0
            memory_budget = budget
            for r in results:
                content = r.get("content", "")
                score = r.get("score", 0.0)
                mem_id = r.get("id", "?")
                source = (r.get("source") or "").split("/")[-1] or "unknown"
                block = f"### Memory #{mem_id} [{source}] (score: {score:.3f})\n{content}\n"
                block_tokens = len(block) // 4  # rough estimate
                if used_tokens + block_tokens > memory_budget:
                    if score > 0.5 and used_tokens + 100 <= memory_budget:
                        truncated = content[:400] + "...\n"
                        trunc_block = f"### Memory #{mem_id} [{source}] (score: {score:.3f})\n{truncated}"
                        trunc_tokens = len(trunc_block) // 4
                        if used_tokens + trunc_tokens <= memory_budget:
                            context_parts.append(trunc_block)
                            used_tokens += trunc_tokens
                    continue
                context_parts.append(block)
                used_tokens += block_tokens

            context = "\n".join(context_parts)
            return {
                "context": context,
                "results": results,
                "top_score": top_score,
                "memory_count": len(results),
            }
    except Exception as exc:
        log.warning(
            "Cortex search failed (non-fatal): error_type=%s",
            type(exc).__name__,
        )
        return None


async def cortex_ingest(
    content: str,
    source: str,
    source_type: str,
    priority: int = 2,
    *,
    idempotency_key: str,
    session_id: str,
    request_id: str,
) -> Optional[dict]:
    """Wait for Cortex to durably accept an exchange and return its receipt."""
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{CORTEX_REST_BASE}/api/v1/ingest",
                json={
                    "agentId": CORTEX_AGENT_ID,
                    "content": content,
                    "source": source,
                    "sourceType": source_type,
                    "priority": priority,
                    "idempotencyKey": idempotency_key,
                    "sessionId": session_id,
                    "requestId": request_id,
                },
            )
            try:
                data = resp.json()
            except Exception:
                data = None

            if not isinstance(data, dict):
                log.warning(
                    "Cortex durable ingest returned an invalid receipt: http_status=%d",
                    resp.status_code,
                )
                return None

            event_id = data.get("eventId")
            status = data.get("status")
            replayed = bool(data.get("replayed", False))
            if not isinstance(event_id, str) or not isinstance(status, str):
                log.warning(
                    "Cortex durable ingest returned an incomplete receipt: http_status=%d",
                    resp.status_code,
                )
                return None

            if status == "indexed":
                log.info(
                    "Cortex capture indexed: event_id=%s replayed=%s chunks=%d synapses=%d",
                    event_id,
                    replayed,
                    int(data.get("chunksStored", 0)),
                    int(data.get("synapsesFormed", 0)),
                )
            elif status in ("accepted", "processing"):
                log.info(
                    "Cortex capture durably accepted; indexing pending: event_id=%s status=%s replayed=%s",
                    event_id,
                    status,
                    replayed,
                )
            elif status == "failed":
                failure = data.get("failure")
                retryable = bool(
                    isinstance(failure, dict) and failure.get("retryable", False)
                )
                log.warning(
                    "Cortex capture failed after durable acceptance: event_id=%s retryable=%s replayed=%s",
                    event_id,
                    retryable,
                    replayed,
                )
            elif status == "rejected":
                log.warning(
                    "Cortex capture rejected: event_id=%s replayed=%s",
                    event_id,
                    replayed,
                )
            else:
                log.warning(
                    "Cortex durable ingest returned an unknown lifecycle status: event_id=%s",
                    event_id,
                )
                return None
            return data
    except Exception as exc:
        log.warning(
            "Cortex durable ingest failed before a receipt: error_type=%s",
            type(exc).__name__,
        )
        return None


# ---------------------------------------------------------------------------
# Request processing
# ---------------------------------------------------------------------------

# Relevance gate over Cortex's public normalized [0,1] search score. Invalid
# configuration fails process startup rather than silently disabling recall.
CORTEX_RELEVANCE_THRESHOLD = float(os.getenv("CORTEX_RELEVANCE_THRESHOLD", "0.5"))
if (
    not math.isfinite(CORTEX_RELEVANCE_THRESHOLD)
    or CORTEX_RELEVANCE_THRESHOLD < 0
    or CORTEX_RELEVANCE_THRESHOLD > 1
):
    raise ValueError("CORTEX_RELEVANCE_THRESHOLD must be between 0 and 1")

# Minimum query length to even attempt recall.  Very short queries
# (1-2 words that aren't trivial) are unlikely to produce useful recall.
CORTEX_MIN_QUERY_LEN = int(os.getenv("CORTEX_MIN_QUERY_LEN", "10"))


async def process_request(messages: list[dict]) -> tuple[list[dict], Optional[str]]:
    """PRE phase: inject recall if appropriate.

    Returns (modified_messages, latest_user_turn) -- the turn is passed to
    the POST phase for capture.

    Throttle design: per-QUERY, not per-session.  If the same query string
    is re-sent within the throttle window, reuse the cached recall block.
    Different queries in the same conversation each get their own recall.
    """
    latest_turn = _extract_latest_user_turn(messages)
    if not latest_turn:
        return messages, None

    # Trivial turns: don't re-recall (the context is already loaded)
    if _TRIVIAL_TURN_RE.match(latest_turn):
        log.debug("Skipping recall for trivial turn")
        return messages, latest_turn

    # Too-short queries: skip recall (unlikely to produce useful results)
    if len(latest_turn) < CORTEX_MIN_QUERY_LEN:
        log.debug("Skipping recall for short query (%d chars)", len(latest_turn))
        return messages, latest_turn

    # Throttle: per-QUERY, not per-session.  If the SAME query was recently
    # recalled, reuse the cached block.  Different queries are NOT throttled.
    query_key = latest_turn[:200]  # cap key length for pathological inputs
    now_ms = time.time() * 1000
    last_ts = _last_recall_ts.get(query_key, 0)
    if CORTEX_RECALL_THROTTLE_MS > 0 and (now_ms - last_ts) < CORTEX_RECALL_THROTTLE_MS:
        block = _last_recall_block.get(query_key, "")
        if block:
            inject_at = _find_inject_point(messages)
            modified = list(messages)
            modified.insert(inject_at, {"role": "system", "content": block})
            log.debug(
                "Reusing cached recall (%dms since last)",
                int(now_ms - last_ts),
            )
            return modified, latest_turn
        log.debug("Recall throttled but no cached block was available")
        return messages, latest_turn

    # Call the shared Cortex REST search path (ordinary CA3 configuration is off)
    recall_result = await cortex_recall(latest_turn, CORTEX_RECALL_BUDGET)
    if not recall_result:
        return messages, latest_turn

    top_score = recall_result.get("top_score", 0.0)
    context = recall_result.get("context", "")
    mem_count = recall_result.get("memory_count", 0)

    # ── Relevance gate: only inject if the top result is relevant enough ──
    if top_score < CORTEX_RELEVANCE_THRESHOLD:
        log.info(
            "Skipping recall: top score %.3f < threshold %.3f",
            top_score,
            CORTEX_RELEVANCE_THRESHOLD,
        )
        return messages, latest_turn

    if not context or not context.strip():
        return messages, latest_turn

    block = _format_recall_block(context, latest_turn)
    if not block:
        return messages, latest_turn

    # Cache for reuse (keyed by query, not session)
    _last_recall_ts[query_key] = now_ms
    _last_recall_query[query_key] = latest_turn
    _last_recall_block[query_key] = block

    # Inject AFTER the stable system prefix (KV-cache-aware)
    inject_at = _find_inject_point(messages)
    modified = list(messages)
    modified.insert(inject_at, {"role": "system", "content": block})

    log.info(
        "Injected recall (%d chars, %d memories, top score %.3f) at pos %d",
        len(block),
        mem_count,
        top_score,
        inject_at,
    )
    return modified, latest_turn


async def capture_exchange(
    latest_turn: str,
    assistant_content: str,
    session_id: str,
    turn_id: str,
) -> Optional[dict]:
    """Durably submit one exact exchange; retries replay through Cortex."""
    if not latest_turn or not assistant_content:
        return None

    # Check for VERIFIED breadcrumb -> request elevated priority. Cortex's
    # central policy remains authoritative for the effective priority.
    priority = 2
    if _VERIFIED_RE.search(latest_turn) or _VERIFIED_RE.search(assistant_content):
        priority = 0
        log.info("VERIFIED breadcrumb detected: requested_priority=%d", priority)

    # Format as a structured exchange for ingest
    content = f"User: {latest_turn}\n\nAssistant: {assistant_content}"
    source = "hermes-gateway"
    source_type = "session"
    idempotency_key = derive_capture_idempotency_key(
        session_id,
        turn_id,
        content,
    )
    return await cortex_ingest(
        content,
        source,
        source_type,
        priority,
        idempotency_key=idempotency_key,
        session_id=session_id,
        request_id=turn_id,
    )


def _extract_assistant_content(response_json: dict) -> str:
    """Extract text from an OpenAI-format chat completion response."""
    try:
        choices = response_json.get("choices", [])
        if not choices:
            return ""
        msg = choices[0].get("message", {})
        content = msg.get("content", "")
        if isinstance(content, list):
            parts = [p.get("text", "") for p in content if isinstance(p, dict)]
            return " ".join(parts)
        return str(content or "")
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Responses API helpers (Codex uses wire_api = "responses")
# ---------------------------------------------------------------------------

def _extract_latest_user_turn_responses(input_field: Any) -> Optional[str]:
    """Extract the latest user message from a Responses API 'input' field.

    The Responses API uses 'input' instead of 'messages'.  It can be:
      - A string (simple prompt)
      - A list of message objects with role/content
    """
    if isinstance(input_field, str):
        return input_field.strip() or None
    if not isinstance(input_field, list):
        return None
    for item in reversed(input_field):
        if not isinstance(item, dict):
            continue
        if item.get("role") == "user" or item.get("type") == "message":
            content = item.get("content", "")
            if isinstance(content, list):
                parts = [
                    p.get("text", "")
                    for p in content
                    if isinstance(p, dict)
                    and (
                        p.get("type", "").startswith("input_text")
                        or p.get("type") == "text"
                    )
                ]
                return " ".join(parts).strip() or None
            return str(content).strip() or None
    return None


def _find_inject_point_responses(input_field: Any) -> tuple[Any, int]:
    """Find injection point in a Responses API 'input' list.

    Returns (input_list, inject_index).  If input is a string, converts it
    to a list with a single user message and injects at index 0.
    """
    if isinstance(input_field, str):
        return [{"role": "user", "content": input_field}], 0
    if not isinstance(input_field, list):
        return input_field, 0
    # Find last system/developer item
    last_sys = -1
    for i, item in enumerate(input_field):
        if not isinstance(item, dict):
            continue
        role = item.get("role", "")
        if role in ("system", "developer"):
            last_sys = i
    return input_field, last_sys + 1


async def process_request_responses(payload: dict) -> tuple[dict, Optional[str]]:
    """PRE phase for Responses API: inject recall if appropriate.

    Returns (modified_payload, latest_user_turn).
    Uses the same per-query throttle and relevance gate as the chat path.
    """
    input_field = payload.get("input")
    latest_turn = _extract_latest_user_turn_responses(input_field)
    if not latest_turn:
        return payload, None

    if _TRIVIAL_TURN_RE.match(latest_turn):
        log.debug("Skipping recall for trivial turn (responses)")
        return payload, latest_turn

    if len(latest_turn) < CORTEX_MIN_QUERY_LEN:
        log.debug("Skipping recall for short query (responses, %d chars)", len(latest_turn))
        return payload, latest_turn

    # Per-query throttle (same as chat path)
    query_key = "resp:" + latest_turn[:200]
    now_ms = time.time() * 1000
    last_ts = _last_recall_ts.get(query_key, 0)
    if CORTEX_RECALL_THROTTLE_MS > 0 and (now_ms - last_ts) < CORTEX_RECALL_THROTTLE_MS:
        block = _last_recall_block.get(query_key, "")
        if block:
            input_list, inject_at = _find_inject_point_responses(input_field)
            if isinstance(input_list, list):
                modified = list(input_list)
                modified.insert(inject_at, {"role": "system", "content": block})
                new_payload = dict(payload)
                new_payload["input"] = modified
                log.debug("Reusing cached recall (responses)")
                return new_payload, latest_turn
        log.debug("Recall throttled but no cached block was available (responses)")
        return payload, latest_turn

    recall_result = await cortex_recall(latest_turn, CORTEX_RECALL_BUDGET)
    if not recall_result:
        return payload, latest_turn

    top_score = recall_result.get("top_score", 0.0)
    context = recall_result.get("context", "")
    mem_count = recall_result.get("memory_count", 0)

    # Relevance gate
    if top_score < CORTEX_RELEVANCE_THRESHOLD:
        log.info(
            "Skipping recall (responses): top score %.3f < threshold %.3f",
            top_score,
            CORTEX_RELEVANCE_THRESHOLD,
        )
        return payload, latest_turn

    if not context or not context.strip():
        return payload, latest_turn

    block = _format_recall_block(context, latest_turn)
    if not block:
        return payload, latest_turn

    _last_recall_ts[query_key] = now_ms
    _last_recall_query[query_key] = latest_turn
    _last_recall_block[query_key] = block

    input_list, inject_at = _find_inject_point_responses(input_field)
    if isinstance(input_list, list):
        modified = list(input_list)
        modified.insert(inject_at, {"role": "system", "content": block})
        new_payload = dict(payload)
        new_payload["input"] = modified
        log.info(
            "Injected recall (%d chars, %d mem, top %.3f) at pos %d (responses)",
            len(block),
            mem_count,
            top_score,
            inject_at,
        )
        return new_payload, latest_turn
    return payload, latest_turn


def _extract_responses_content(response_json: dict) -> str:
    """Extract assistant text from a non-streaming Responses API result."""
    try:
        output = response_json.get("output", [])
        if not isinstance(output, list):
            return ""
        parts = []
        for item in output:
            if not isinstance(item, dict):
                continue
            # Message items have content[].text
            if item.get("type") == "message":
                content = item.get("content", [])
                if isinstance(content, list):
                    for c in content:
                        if isinstance(c, dict):
                            parts.append(c.get("text", ""))
        return " ".join(p for p in parts if p)
    except Exception:
        return ""


def _sse_event_end(buffer: bytearray, *, final: bool) -> Optional[int]:
    """Find one SSE blank-line boundary without splitting a pending CRLF."""
    previous_was_line_end = False
    index = 0
    while index < len(buffer):
        current = buffer[index]
        line_end_size = 0
        if current == 0x0A:
            line_end_size = 1
        elif current == 0x0D:
            if index + 1 >= len(buffer):
                if not final:
                    return None
                line_end_size = 1
            else:
                line_end_size = 2 if buffer[index + 1] == 0x0A else 1

        if line_end_size == 0:
            previous_was_line_end = False
            index += 1
            continue
        index += line_end_size
        if previous_was_line_end:
            return index
        previous_was_line_end = True
    return None


class _SseEventBuffer:
    """Buffer raw SSE bytes until complete events can be decoded safely."""

    def __init__(self) -> None:
        self._buffer = bytearray()

    def feed(self, chunk: bytes) -> list[bytes]:
        self._buffer.extend(chunk)
        events: list[bytes] = []
        while True:
            end = _sse_event_end(self._buffer, final=False)
            if end is None:
                break
            events.append(bytes(self._buffer[:end]))
            del self._buffer[:end]
        return events

    def finish(self) -> list[bytes]:
        events: list[bytes] = []
        while self._buffer:
            end = _sse_event_end(self._buffer, final=True)
            if end is None:
                events.append(bytes(self._buffer))
                self._buffer.clear()
                break
            events.append(bytes(self._buffer[:end]))
            del self._buffer[:end]
        return events


def _sse_data_payload(event: bytes) -> Optional[str]:
    """Decode one complete SSE event and join its data fields per the spec."""
    try:
        text = event.decode("utf-8")
    except UnicodeDecodeError:
        return None
    text = text.removeprefix("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    data_lines: list[str] = []
    found_data = False
    for line in text.split("\n"):
        if not line or line.startswith(":"):
            continue
        field, separator, value = line.partition(":")
        if field != "data":
            continue
        found_data = True
        if separator and value.startswith(" "):
            value = value[1:]
        data_lines.append(value)
    return "\n".join(data_lines) if found_data else None


def _chat_delta_content(data_payload: Optional[str]) -> str:
    """Extract one assistant text delta from a Chat Completions SSE event."""
    if data_payload is None or data_payload.strip() == "[DONE]":
        return ""
    try:
        event = json.loads(data_payload)
    except (json.JSONDecodeError, TypeError):
        return ""
    choices = event.get("choices", []) if isinstance(event, dict) else []
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return ""
    delta = choices[0].get("delta", {})
    if not isinstance(delta, dict):
        return ""
    content = delta.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            text = part.get("text")
            if isinstance(text, str):
                parts.append(text)
        return "".join(parts)
    return ""


async def _iter_sse_events(
    chunks: AsyncIterable[bytes],
) -> AsyncIterator[bytes]:
    """Yield complete raw events across arbitrary byte and UTF-8 splits."""
    event_buffer = _SseEventBuffer()
    async for chunk in chunks:
        if not chunk:
            continue
        for event in event_buffer.feed(bytes(chunk)):
            yield event
    for event in event_buffer.finish():
        yield event


async def _forward_chat_sse(
    chunks: AsyncIterable[bytes],
    write: Callable[[bytes], Awaitable[Any]],
    latest_turn: Optional[str],
    session_id: str,
    turn_id: str,
) -> Optional[dict]:
    """Pass through chat SSE while gating terminal acknowledgement on capture."""
    accumulated_content: list[str] = []
    pending_after_terminal: list[tuple[bool, bytes]] = []
    terminal_seen = False

    async for event in _iter_sse_events(chunks):
        data_payload = _sse_data_payload(event)
        is_terminal = (
            data_payload is not None and data_payload.strip() == "[DONE]"
        )
        if is_terminal:
            terminal_seen = True
            pending_after_terminal.append((True, event))
            break

        content = _chat_delta_content(data_payload)
        if content:
            accumulated_content.append(content)
        if terminal_seen:
            pending_after_terminal.append((False, event))
        else:
            await write(event)

    capture_required = bool(terminal_seen and latest_turn and accumulated_content)
    receipt = None
    if capture_required:
        receipt = await capture_exchange(
            latest_turn,
            "".join(accumulated_content),
            session_id,
            turn_id,
        )

    for is_terminal, event in pending_after_terminal:
        if not is_terminal or not capture_required or receipt is not None:
            await write(event)
    if terminal_seen and capture_required and receipt is None:
        log.warning(
            "Suppressing chat completion marker without a durable capture receipt"
        )
    elif not terminal_seen and accumulated_content:
        log.warning("Upstream chat stream ended without a completion marker")
    return receipt


def _responses_stream_event(event_type: str, **fields: Any) -> bytes:
    payload = {"type": event_type, **fields}
    return f"data: {json.dumps(payload)}\n\n".encode("utf-8")


async def _forward_responses_sse(
    chunks: AsyncIterable[bytes],
    write: Callable[[bytes], Awaitable[Any]],
    latest_turn: Optional[str],
    session_id: str,
    turn_id: str,
) -> Optional[dict]:
    """Translate chat SSE to Responses SSE and gate its terminal events."""
    accumulated_content: list[str] = []
    terminal_seen = False

    async for event in _iter_sse_events(chunks):
        data_payload = _sse_data_payload(event)
        if data_payload is not None and data_payload.strip() == "[DONE]":
            terminal_seen = True
            break
        content = _chat_delta_content(data_payload)
        if not content:
            continue
        accumulated_content.append(content)
        await write(
            _responses_stream_event("response.output_text.delta", delta=content)
        )

    capture_required = bool(terminal_seen and latest_turn and accumulated_content)
    receipt = None
    if capture_required:
        receipt = await capture_exchange(
            latest_turn,
            "".join(accumulated_content),
            session_id,
            turn_id,
        )

    if not terminal_seen:
        log.warning("Upstream Responses stream ended without a completion marker")
    elif not capture_required or receipt is not None:
        await write(_responses_stream_event("response.output_text.done"))
        await write(_responses_stream_event("response.done"))
    else:
        log.warning(
            "Suppressing Responses completion marker without a durable capture receipt"
        )
    return receipt


# ---------------------------------------------------------------------------
# HTTP server (aiohttp -- zero external deps beyond httpx)
# ---------------------------------------------------------------------------

# We use aiohttp for the server side so we get native streaming passthrough
# without pulling in FastAPI/uvicorn.  httpx handles the upstream proxying.

try:
    from aiohttp import web
except ImportError:
    raise SystemExit(
        "aiohttp is required.  Install with:  pip install aiohttp httpx"
    )

# Reuse a single httpx client for upstream forwarding
_upstream_client: Optional[httpx.AsyncClient] = None


async def get_upstream_client() -> httpx.AsyncClient:
    global _upstream_client
    if _upstream_client is None or _upstream_client.is_closed:
        _upstream_client = httpx.AsyncClient(timeout=300.0)
    return _upstream_client


async def proxy_chat_completions(request: web.Request) -> web.StreamResponse:
    """Handle POST /v1/chat/completions -- the main gateway endpoint."""
    body = await request.read()
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return web.json_response({"error": "invalid JSON"}, status=400)

    capture_session_id, capture_turn_id = derive_capture_lineage(
        "chat",
        payload,
        request.headers,
    )
    messages = payload.get("messages", [])
    stream = payload.get("stream", False)

    # ── PRE: deterministic recall injection ──
    modified_messages, latest_turn = await process_request(messages)
    for msg in modified_messages:
        if msg.get("role") == "developer":
            msg["role"] = "system"
    payload["messages"] = modified_messages
    payload["model"] = "gemma4-26b:latest"
    log.info(
        "Forwarding chat completion: keys=%s messages=%d stream=%s",
        sorted(payload.keys()),
        len(modified_messages),
        stream,
    )

    # ── FORWARD to real upstream ──
    upstream_url = f"{CORTEX_UPSTREAM}/chat/completions"
    headers = dict(request.headers)
    # Strip hop-by-hop headers
    for h in ("Host", "Transfer-Encoding", "Content-Length", "Content-Encoding"):
        headers.pop(h, None)

    client = await get_upstream_client()

    if stream:
        # Streaming: forward as Server-Sent Events, capture final content
        # by accumulating delta chunks.
        async with client.stream(
            "POST", upstream_url,
            content=json.dumps(payload),
            headers=headers,
        ) as upstream_resp:
            if upstream_resp.status_code >= 400:
                error_body = await upstream_resp.aread()
                log.error("Upstream returned status=%d", upstream_resp.status_code)
                return web.Response(status=upstream_resp.status_code, body=error_body)

            response = web.StreamResponse(
                status=upstream_resp.status_code,
                headers={
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                },
            )
            await response.prepare(request)

            await _forward_chat_sse(
                upstream_resp.aiter_bytes(),
                response.write,
                latest_turn,
                capture_session_id,
                capture_turn_id,
            )

            return response
    else:
        # Non-streaming: forward, capture, return
        upstream_resp = await client.post(
            upstream_url,
            content=json.dumps(payload),
            headers=headers,
        )

        # ── POST: capture ──
        if latest_turn:
            try:
                resp_json = upstream_resp.json()
                assistant_content = _extract_assistant_content(resp_json)
                await capture_exchange(
                    latest_turn,
                    assistant_content,
                    capture_session_id,
                    capture_turn_id,
                )
            except Exception as exc:
                log.debug(
                    "Capture skipped after response parsing failure: error_type=%s",
                    type(exc).__name__,
                )

        # Return upstream response to client
        return web.Response(
            status=upstream_resp.status_code,
            body=upstream_resp.content,
            content_type=upstream_resp.headers.get("content-type", "application/json"),
        )


async def proxy_responses(request: web.Request) -> web.StreamResponse:
    """Handle POST /v1/responses -- Codex uses this (wire_api = "responses").

    Responses API uses 'input' instead of 'messages' and 'output' instead of
    'choices'.  Streaming uses event-typed SSE (response.output_text.delta, etc.).
    """
    body = await request.read()
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return web.json_response({"error": "invalid JSON"}, status=400)

    capture_session_id, capture_turn_id = derive_capture_lineage(
        "responses",
        payload,
        request.headers,
    )
    stream = payload.get("stream", False)

    # ── PRE: deterministic recall injection (Responses API) ──
    modified_payload, latest_turn = await process_request_responses(payload)

    # ── FORWARD to real upstream (translated to chat/completions) ──
    upstream_url = f"{CORTEX_UPSTREAM}/chat/completions"
    headers = dict(request.headers)
    for h in ("Host", "Transfer-Encoding", "Content-Length", "Content-Encoding"):
        headers.pop(h, None)

    chat_payload = {
        "model": "gemma4-26b:latest",
        "stream": stream,
        "messages": []
    }
    # Pass along tools if they exist
    if "tools" in modified_payload:
        chat_payload["tools"] = modified_payload["tools"]

    input_list = modified_payload.get("input", [])
    if isinstance(input_list, str):
        chat_payload["messages"].append({"role": "user", "content": input_list})
    elif isinstance(input_list, list):
        for item in input_list:
            if not isinstance(item, dict): continue
            role = item.get("role", "user")
            if role == "developer": role = "system"
            content = item.get("content", "")
            if isinstance(content, list):
                parts = [p.get("text", "") for p in content if isinstance(p, dict) and "text" in p]
                content = "\n".join(parts)
            chat_payload["messages"].append({"role": role, "content": content})

    log.info(f"Translated payload keys: {list(chat_payload.keys())}, messages count: {len(chat_payload['messages'])}")

    client = await get_upstream_client()

    if stream:
        async with client.stream(
            "POST", upstream_url,
            content=json.dumps(chat_payload),
            headers=headers,
        ) as upstream_resp:
            if upstream_resp.status_code >= 400:
                error_body = await upstream_resp.aread()
                log.error("Upstream returned status=%d", upstream_resp.status_code)
                return web.Response(status=upstream_resp.status_code, body=error_body)

            response = web.StreamResponse(
                status=upstream_resp.status_code,
                headers={
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                },
            )
            await response.prepare(request)

            await _forward_responses_sse(
                upstream_resp.aiter_bytes(),
                response.write,
                latest_turn,
                capture_session_id,
                capture_turn_id,
            )

            return response
    else:
        upstream_resp = await client.post(
            upstream_url,
            content=json.dumps(chat_payload),
            headers=headers,
        )
        if upstream_resp.status_code >= 400:
            log.error("Upstream returned status=%d", upstream_resp.status_code)

        resp_json = {}
        try:
            resp_json = upstream_resp.json()
            assistant_content = _extract_assistant_content(resp_json)
        except Exception:
            assistant_content = ""

        responses_payload = {
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "text", "text": assistant_content}]
                }
            ]
        }

        # ── POST: capture ──
        if latest_turn and assistant_content:
            try:
                await capture_exchange(
                    latest_turn,
                    assistant_content,
                    capture_session_id,
                    capture_turn_id,
                )
            except Exception as exc:
                log.debug(
                    "Capture skipped after Responses parsing failure: error_type=%s",
                    type(exc).__name__,
                )

        return web.json_response(responses_payload, status=upstream_resp.status_code)


async def proxy_generic(request: web.Request) -> web.StreamResponse:
    """Transparent proxy for all other /v1/* endpoints (models, embeddings, etc.).

    No Cortex injection -- just passthrough so the gateway is a drop-in
    replacement for the upstream base URL.
    """
    path = request.path_qs
    upstream_url = f"{CORTEX_UPSTREAM}{path.replace('/v1', '', 1)}"
    headers = dict(request.headers)
    for h in ("Host", "Transfer-Encoding", "Content-Length", "Content-Encoding"):
        headers.pop(h, None)

    client = await get_upstream_client()
    body = await request.read() if request.method in ("POST", "PUT", "PATCH") else None

    upstream_resp = await client.request(
        request.method, upstream_url,
        content=body,
        headers=headers,
    )
    return web.Response(
        status=upstream_resp.status_code,
        body=upstream_resp.content,
        content_type=upstream_resp.headers.get("content-type", "application/json"),
    )


async def health(request: web.Request) -> web.Response:
    """GET /health -- gateway liveness + Cortex REST reachability."""
    status = {
        "gateway": "ok",
        "cortex_rest_base": CORTEX_REST_BASE,
        "agent_id": CORTEX_AGENT_ID,
        "upstream": CORTEX_UPSTREAM,
        "recall_budget": CORTEX_RECALL_BUDGET,
        "recall_throttle_ms": CORTEX_RECALL_THROTTLE_MS,
        "relevance_threshold": CORTEX_RELEVANCE_THRESHOLD,
        "min_query_len": CORTEX_MIN_QUERY_LEN,
    }
    # Quick Cortex REST ping
    try:
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.get(f"{CORTEX_REST_BASE}/api/v1/status",
                            params={"agentId": CORTEX_AGENT_ID})
            status["cortex_rest"] = "ok" if r.status_code == 200 else f"err:{r.status_code}"
    except Exception as exc:
        status["cortex_rest"] = f"unreachable: {exc}"
    return web.json_response(status)


async def on_shutdown(app: web.Application) -> None:
    global _upstream_client
    if _upstream_client and not _upstream_client.is_closed:
        await _upstream_client.aclose()


def create_app() -> web.Application:
    app = web.Application(client_max_size=50 * 1024 * 1024)
    # Chat Completions API (Hermes, OpenAI-compatible clients)
    app.router.add_post("/v1/chat/completions", proxy_chat_completions)
    # Responses API (Codex uses wire_api = "responses")
    app.router.add_post("/v1/responses", proxy_responses)
    # Transparent passthrough for everything else
    app.router.add_get("/v1/models", proxy_generic)
    app.router.add_post("/v1/embeddings", proxy_generic)
    app.router.add_route("*", "/v1/{tail:.*}", proxy_generic)
    app.router.add_get("/health", health)
    app.router.add_get("/", health)
    app.on_shutdown.append(on_shutdown)
    return app


def main() -> None:
    log.info("Cortex Memory Gateway starting on %s:%d", CORTEX_GATEWAY_BIND, CORTEX_GATEWAY_PORT)
    log.info("  Cortex REST: %s (agent: %s)", CORTEX_REST_BASE, CORTEX_AGENT_ID)
    log.info("  Upstream:   %s", CORTEX_UPSTREAM)
    log.info("  Recall budget: %d tokens, throttle: %dms",
             CORTEX_RECALL_BUDGET, CORTEX_RECALL_THROTTLE_MS)
    web.run_app(create_app(), host=CORTEX_GATEWAY_BIND, port=CORTEX_GATEWAY_PORT,
                access_log=None)


if __name__ == "__main__":
    main()
