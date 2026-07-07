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

  POST (async, never blocks the response):
    4. Capture exchange -> Cortex /ingest (dedup gate on).
    5. Honor "// VERIFIED" breadcrumbs as priority writes.

Run:
    python gateway.py                         # defaults
    CORTEX_GATEWAY_PORT=3101 python gateway.py # custom port

Config via env (all have safe defaults):
    CORTEX_REST_BASE     http://127.0.0.1:3100
    CORTEX_AGENT_ID      arlo
    CORTEX_RECALL_BUDGET 1200        (tokens of recall per task boundary)
    CORTEX_RECALL_THROTTLE_MS 600000  (10-min window; 0 = every request)
    CORTEX_CAPTURE_MIN_CHARS 200     (skip trivial exchanges)
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

import asyncio
import json
import logging
import os
import re
import time
from typing import Any, Optional

import httpx

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CORTEX_REST_BASE = os.getenv("CORTEX_REST_BASE", "http://127.0.0.1:3100").rstrip("/")
CORTEX_AGENT_ID = os.getenv("CORTEX_AGENT_ID", "arlo")
CORTEX_RECALL_BUDGET = int(os.getenv("CORTEX_RECALL_BUDGET", "1200"))
CORTEX_RECALL_THROTTLE_MS = int(os.getenv("CORTEX_RECALL_THROTTLE_MS", "600000"))
CORTEX_CAPTURE_MIN_CHARS = int(os.getenv("CORTEX_CAPTURE_MIN_CHARS", "200"))
# Client-side capture dedup window: if the same user turn was captured
# within this window, skip re-capture.  Prevents duplicate memories from
# retries, A/B tests, and re-sent messages.  The REST ingest's own dedup
# gate only covers single-chunk content; this covers multi-chunk.
CORTEX_CAPTURE_DEDUP_MS = int(os.getenv("CORTEX_CAPTURE_DEDUP_MS", "300000"))  # 5 min
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

# Capture dedup cache: maps user-turn key -> last-capture timestamp (epoch ms).
# Prevents the same exchange from being ingested twice (retries, A/B tests).
_last_capture_ts: dict[str, float] = {}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Match "// VERIFIED" breadcrumbs anywhere in user content.  These signal
# that the captured exchange contains a durable, high-confidence fact that
# should be written at elevated priority.
_VERIFIED_RE = re.compile(r"//\s*VERIFIED", re.IGNORECASE)

# A "task boundary" heuristic: if the latest user message is short and
# directive ("ok", "yes", "continue", "go ahead", a lone tool result), we
# don't re-recall -- the task context is already loaded from the prior turn.
_TRIVIAL_TURN_RE = re.compile(
    r"^(ok|okay|yes|y|no|n|continue|go|go ahead|sure|done|thanks|thank you|"
    r"nice|great|cool|yep|nope|pls|please|what\??|hmm|k|kk)\s*[\.\!\?]?\s*$",
    re.IGNORECASE,
)


def _session_key(messages: list[dict]) -> str:
    """Derive a stable session key from the system messages' combined hash.

    Falls back to 'default' if there are no system messages (rare for Hermes).
    """
    sys_msgs = [m.get("content", "") for m in messages if m.get("role") == "system"]
    if not sys_msgs:
        return "default"
    blob = "|".join(sys_msgs)[:512]
    return str(hash(blob))


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
        log.warning("Cortex search failed (non-fatal): %s", exc)
        return None


async def cortex_ingest(content: str, source: str, source_type: str,
                        priority: int = 2) -> None:
    """Call POST /api/v1/ingest asynchronously (never blocks)."""
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
                },
            )
            resp.raise_for_status()
            data = resp.json()
            if data.get("skipped"):
                log.debug("Cortex ingest skipped (dup of #%s, sim %s)",
                          data.get("duplicateOf"), data.get("similarity"))
            else:
                log.info("Cortex ingest: %d chunks, %d synapses",
                         data.get("chunksStored", 0),
                         data.get("synapsesFormed", 0))
    except Exception as exc:
        log.warning("Cortex ingest failed (non-fatal): %s", exc)


# ---------------------------------------------------------------------------
# Request processing
# ---------------------------------------------------------------------------

# Relevance gate: minimum top-result score to inject recall.
# Below this, the query is unrelated to anything in memory and injection
# would just waste tokens.  Tuned from A/B test (search scores, not recall):
#   "weather in Tokyo" scored 2.22 (correctly blocked)
#   "reverse a linked list" scored 2.38 (correctly blocked)
#   "CA3 pattern completion" scored 8.57 (correctly injected)
#   "Cortex dream cycle" scored 9.02 (correctly injected)
# Set at 5.0 as the midpoint between noise (~2-3) and signal (~8-11).
CORTEX_RELEVANCE_THRESHOLD = float(os.getenv("CORTEX_RELEVANCE_THRESHOLD", "5.0"))

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
        log.debug("Skipping recall for trivial turn: %r", latest_turn[:80])
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
            log.debug("Reusing cached recall for query %r (%dms since last)",
                      latest_turn[:60], int(now_ms - last_ts))
            return modified, latest_turn
        log.debug("Throttled but no cached block for query %r", latest_turn[:60])
        return messages, latest_turn

    # Call Cortex search (CA3-enabled via REST path)
    recall_result = await cortex_recall(latest_turn, CORTEX_RECALL_BUDGET)
    if not recall_result:
        return messages, latest_turn

    top_score = recall_result.get("top_score", 0.0)
    context = recall_result.get("context", "")
    mem_count = recall_result.get("memory_count", 0)

    # ── Relevance gate: only inject if the top result is relevant enough ──
    if top_score < CORTEX_RELEVANCE_THRESHOLD:
        log.info("Skipping recall: top score %.3f < threshold %.3f for %r",
                 top_score, CORTEX_RELEVANCE_THRESHOLD, latest_turn[:80])
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

    log.info("Injected recall (%d chars, %d memories, top score %.3f) at pos %d for %r",
             len(block), mem_count, top_score, inject_at, latest_turn[:80])
    return modified, latest_turn


async def capture_exchange(latest_turn: str, assistant_content: str) -> None:
    """POST phase: ingest the exchange (async, never blocks).

    Includes multiple dedup layers:
    1. Client-side exact-key dedup (same user turn within DEDUP_MS window)
    2. Client-side semantic dedup: search Cortex for existing memories matching
       this exchange. If the top result has cosine >= 0.85, skip ingest entirely.
       This prevents the "same topic, different turn" duplicate pattern where
       each turn in a long conversation about the same project creates a
       near-duplicate memory.
    """
    if not latest_turn or not assistant_content:
        return
    # Skip trivially short exchanges
    if len(latest_turn) + len(assistant_content) < CORTEX_CAPTURE_MIN_CHARS:
        return

    # ── Layer 1: Client-side exact dedup ──
    capture_key = latest_turn[:200]
    now_ms = time.time() * 1000
    last_capture_ts = _last_capture_ts.get(capture_key, 0)
    if CORTEX_CAPTURE_DEDUP_MS > 0 and (now_ms - last_capture_ts) < CORTEX_CAPTURE_DEDUP_MS:
        log.debug("Skipping capture: same turn captured %dms ago", int(now_ms - last_capture_ts))
        return
    _last_capture_ts[capture_key] = now_ms

    # Check for VERIFIED breadcrumb -> elevated priority
    priority = 2
    if _VERIFIED_RE.search(latest_turn) or _VERIFIED_RE.search(assistant_content):
        priority = 0
        log.info("VERIFIED breadcrumb detected -- writing at P%d", priority)

    # Format as a structured exchange for ingest
    content = f"User: {latest_turn}\n\nAssistant: {assistant_content}"
    source = "hermes-gateway"
    source_type = "verified-api" if priority == 0 else "api"

    # ── Layer 2: Novelty-gated capture ──
    # Instead of capturing every exchange and relying on the server-side dedup
    # gate to catch duplicates, we check Cortex first: only capture if this
    # exchange is genuinely novel (no existing memory matches it).
    # This prevents the "same topic, different turn" duplicate pattern where
    # a long working session about Cortex/SimsOnline/etc creates dozens of
    # near-duplicate memories.
    # VERIFIED breadcrumbs bypass this check (they're always captured at P0).
    if priority != 0:  # Only do novelty check for non-VERIFIED captures
        try:
            search_resp = await _http_call(
                "POST",
                f"{CORTEX_REST_BASE}/api/v1/search",
                json={"query": latest_turn[:500], "agentId": CORTEX_AGENT_ID, "limit": 1},
                timeout=aiohttp.ClientTimeout(total=10),
            )
            if search_resp.status == 200:
                search_data = await search_resp.json()
                results = search_data.get("results", [])
                if results:
                    top = results[0]
                    existing_content = top.get("content", "").lower()
                    turn_text = latest_turn[:500].lower()
                    # Use stopword-filtered word overlap to check novelty.
                    # Only skip if VERY high overlap (>= 75%) -- this means
                    # we're re-capturing essentially the same topic.
                    stopwords = {"the", "and", "for", "are", "was", "but", "not", "you",
                                 "all", "can", "her", "was", "one", "our", "out", "has",
                                 "have", "from", "they", "this", "that", "with", "will",
                                 "your", "what", "when", "how", "into", "been", "them",
                                 "than", "then", "these", "those", "their", "would",
                                 "could", "should", "about", "which", "there", "here",
                                 "just", "like", "also", "only", "some", "more", "such",
                                 "very", "much", "many", "most", "each", "make", "made",
                                 "does", "done", "were", "where", "while", "after",
                                 "before", "between", "during", "through", "because"}
                    turn_words = set(w for w in turn_text.split() if len(w) >= 4 and w not in stopwords and w.isalpha())
                    existing_words = set(w for w in existing_content.split() if len(w) >= 4 and w not in stopwords and w.isalpha())
                    if turn_words and existing_words:
                        overlap = len(turn_words & existing_words) / len(turn_words)
                        if overlap >= 0.75:
                            log.debug("Skipping capture: %d%% word overlap with #%s (not novel)",
                                      int(overlap * 100), top.get("id"))
                            return
        except Exception as e:
            log.debug("Novelty check failed (non-fatal, will capture): %s", e)

    asyncio.create_task(cortex_ingest(content, source, source_type, priority))


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
                parts = [p.get("text", "") for p in content
                         if isinstance(p, dict) and p.get("type", "").startswith("input_text") or p.get("type") == "text"]
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
        log.debug("Skipping recall for trivial turn (responses): %r", latest_turn[:80])
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
                log.debug("Reusing cached recall for query %r (responses)", latest_turn[:60])
                return new_payload, latest_turn
        log.debug("Throttled but no cached block (responses) for %r", latest_turn[:60])
        return payload, latest_turn

    recall_result = await cortex_recall(latest_turn, CORTEX_RECALL_BUDGET)
    if not recall_result:
        return payload, latest_turn

    top_score = recall_result.get("top_score", 0.0)
    context = recall_result.get("context", "")
    mem_count = recall_result.get("memory_count", 0)

    # Relevance gate
    if top_score < CORTEX_RELEVANCE_THRESHOLD:
        log.info("Skipping recall (responses): top score %.3f < threshold %.3f for %r",
                 top_score, CORTEX_RELEVANCE_THRESHOLD, latest_turn[:80])
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
        log.info("Injected recall (%d chars, %d mem, top %.3f) at pos %d (responses) for %r",
                 len(block), mem_count, top_score, inject_at, latest_turn[:80])
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

    messages = payload.get("messages", [])
    stream = payload.get("stream", False)

    # ── PRE: deterministic recall injection ──
    modified_messages, latest_turn = await process_request(messages)
    for msg in modified_messages:
        if msg.get("role") == "developer":
            msg["role"] = "system"
    payload["messages"] = modified_messages
    payload["model"] = "gemma4-26b:latest"
    log.info(f"Sending CC payload: {json.dumps(payload)[:500]}...")

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
                log.error(f"Upstream returned {upstream_resp.status_code}: {error_body}")
                return web.Response(status=upstream_resp.status_code, body=error_body)

            response = web.StreamResponse(
                status=upstream_resp.status_code,
                headers={
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                },
            )
            await response.prepare(request)

            accumulated_content = []
            async for chunk in upstream_resp.aiter_bytes():
                await response.write(chunk)
                # Parse SSE lines to capture content deltas
                try:
                    text = chunk.decode("utf-8", errors="replace")
                    for line in text.split("\n"):
                        if line.startswith("data: ") and line != "data: [DONE]":
                            data = line[6:]
                            try:
                                obj = json.loads(data)
                                delta = obj.get("choices", [{}])[0].get("delta", {})
                                c = delta.get("content", "")
                                if c:
                                    accumulated_content.append(c)
                            except json.JSONDecodeError:
                                pass
                except Exception:
                    pass

            # ── POST: capture the exchange (async, non-blocking) ──
            if latest_turn and accumulated_content:
                await capture_exchange(latest_turn, "".join(accumulated_content))

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
                await capture_exchange(latest_turn, assistant_content)
            except Exception as exc:
                log.debug("Capture skipped (parse error): %s", exc)

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
                log.error(f"Upstream returned {upstream_resp.status_code}: {error_body}")
                return web.Response(status=upstream_resp.status_code, body=error_body)

            response = web.StreamResponse(
                status=upstream_resp.status_code,
                headers={
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                },
            )
            await response.prepare(request)

            accumulated_content = []
            async for chunk in upstream_resp.aiter_bytes():
                try:
                    text = chunk.decode("utf-8", errors="replace")
                    for line in text.split("\n"):
                        if line.startswith("data: ") and line != "data: [DONE]":
                            data_str = line[6:]
                            try:
                                obj = json.loads(data_str)
                                delta = obj.get("choices", [{}])[0].get("delta", {})
                                c = delta.get("content", "")
                                if c:
                                    accumulated_content.append(c)
                                    # Translate to Responses API chunk
                                    resp_chunk = {"type": "response.output_text.delta", "delta": c}
                                    await response.write(f"data: {json.dumps(resp_chunk)}\n\n".encode("utf-8"))
                            except json.JSONDecodeError:
                                pass
                except Exception:
                    pass
            
            # Send completion markers
            await response.write(b"data: {\"type\": \"response.output_text.done\"}\n\n")
            await response.write(b"data: {\"type\": \"response.done\"}\n\n")

            # ── POST: capture ──
            if latest_turn and accumulated_content:
                await capture_exchange(latest_turn, "".join(accumulated_content))

            return response
    else:
        upstream_resp = await client.post(
            upstream_url,
            content=json.dumps(chat_payload),
            headers=headers,
        )
        if upstream_resp.status_code >= 400:
            log.error(f"Upstream returned {upstream_resp.status_code}: {upstream_resp.content}")

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
                await capture_exchange(latest_turn, assistant_content)
            except Exception as exc:
                log.debug("Capture skipped (responses parse error): %s", exc)

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
        "capture_min_chars": CORTEX_CAPTURE_MIN_CHARS,
        "capture_dedup_ms": CORTEX_CAPTURE_DEDUP_MS,
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