#!/usr/bin/env python3
"""
CORTEX Gateway A/B Test

Compares responses with the gateway (recall-inject ON) vs direct to Ollama
(recall-inject OFF). Measures:
  1. Token overhead (how many extra tokens the injection adds to the prompt)
  2. Latency (TTFB and total time)
  3. Whether the model actually uses the injected memory (keyword overlap)
  4. Recall relevance (does the injected content match the query?)

Usage:
    python scripts/gateway-ab-test.py

Outputs a JSON report to stdout and a human-readable summary to stderr.
"""

import json
import time
import sys
import re
from typing import Optional

import httpx

GATEWAY = "http://127.0.0.1:3101/v1"
DIRECT = "http://127.0.0.1:11434/v1"
CORTEX_REST = "http://127.0.0.1:3100/api/v1"
MODEL = "glm-5.2:cloud"
AGENT_ID = "arlo"

# Test queries -- designed to probe different scenarios:
#   1. A query that SHOULD match existing Cortex memories (Cortex project context)
#   2. A query that is generic (should get minimal recall)
#   3. A query about a specific past decision (should surface it if recall works)
#   4. A trivial turn (should be skipped by the throttle)
TEST_QUERIES = [
    {
        "id": "cortex-specific",
        "query": "What do you know about the Cortex memory system's dream cycle?",
        "expect_recall": True,
        "description": "Query directly about Cortex -- should match existing memories",
    },
    {
        "id": "generic-coding",
        "query": "Write a Python function to reverse a linked list.",
        "expect_recall": False,
        "description": "Generic coding task -- recall may or may not be useful",
    },
    {
        "id": "cortex-architecture",
        "query": "How does the CA3 pattern completion work in the hippocampal memory system?",
        "expect_recall": True,
        "description": "Query about CA3 -- should match technical Cortex memories",
    },
    {
        "id": "trivial",
        "query": "ok",
        "expect_recall": False,
        "description": "Trivial turn -- should be SKIPPED by the throttle",
    },
    {
        "id": "unrelated",
        "query": "What is the weather like in Tokyo?",
        "expect_recall": False,
        "description": "Unrelated query -- recall should be low-relevance if it fires",
    },
]


def make_payload(query: str, system: str = "You are a helpful assistant. Answer concisely.") -> dict:
    """Build a chat completions payload."""
    return {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": query},
        ],
        "max_tokens": 300,
        "stream": False,
    }


def send_request(url: str, payload: dict, timeout: int = 120) -> tuple[dict, float, Optional[str]]:
    """Send a request and return (response_json, elapsed_seconds, error)."""
    try:
        start = time.time()
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(f"{url}/chat/completions", json=payload)
            elapsed = time.time() - start
            if resp.status_code != 200:
                return {}, elapsed, f"HTTP {resp.status_code}: {resp.text[:200]}"
            return resp.json(), elapsed, None
    except Exception as exc:
        return {}, 0.0, str(exc)


def get_recall_direct(query: str) -> dict:
    """Call Cortex REST search directly to see what would be injected."""
    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(f"{CORTEX_REST}/search", json={
                "query": query,
                "agentId": AGENT_ID,
                "limit": 10,
            })
            if resp.status_code == 200:
                data = resp.json()
                results = data.get("results", [])
                top_score = results[0].get("score", 0.0) if results else 0.0
                context = ""
                if results:
                    parts = ["## Relevant Memories\n"]
                    for r in results:
                        content = r.get("content", "")
                        score = r.get("score", 0.0)
                        mem_id = r.get("id", "?")
                        source = (r.get("source") or "").split("/")[-1] or "unknown"
                        parts.append(f"### Memory #{mem_id} [{source}] (score: {score:.3f})\n{content}\n")
                    context = "\n".join(parts)
                return {
                    "context": context,
                    "results": results,
                    "top_score": top_score,
                    "memory_count": len(results),
                }
    except Exception as exc:
        return {"error": str(exc)}
    return {"error": f"HTTP {resp.status_code}"}


def count_tokens_approx(text: str) -> int:
    """Rough token count (4 chars per token heuristic)."""
    return len(text) // 4


def extract_assistant_text(resp: dict) -> str:
    """Extract the assistant's text from a chat completion response."""
    try:
        choices = resp.get("choices", [])
        if not choices:
            return ""
        msg = choices[0].get("message", {})
        content = msg.get("content", "")
        if isinstance(content, list):
            return " ".join(p.get("text", "") for p in content if isinstance(p, dict))
        return str(content or "")
    except Exception:
        return ""


def extract_usage(resp: dict) -> dict:
    """Extract token usage info."""
    usage = resp.get("usage", {})
    return {
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "completion_tokens": usage.get("completion_tokens", 0),
        "total_tokens": usage.get("total_tokens", 0),
    }


def keyword_overlap(text1: str, text2: str) -> float:
    """Compute Jaccard similarity of word sets between two texts."""
    if not text1 or not text2:
        return 0.0
    words1 = set(re.findall(r'\b\w{4,}\b', text1.lower()))
    words2 = set(re.findall(r'\b\w{4,}\b', text2.lower()))
    if not words1 or not words2:
        return 0.0
    intersection = words1 & words2
    union = words1 | words2
    return len(intersection) / len(union) if union else 0.0


def run_test():
    results = []

    for test in TEST_QUERIES:
        test_id = test["id"]
        query = test["query"]
        print(f"\n{'='*60}", file=sys.stderr)
        print(f"Test: {test_id} -- {test['description']}", file=sys.stderr)
        print(f"Query: {query!r}", file=sys.stderr)

        # Step 1: See what Cortex search WOULD return for this query
        recall_data = get_recall_direct(query)
        if "error" in recall_data:
            recall_context = ""
            recall_token_count = 0
            recall_mem_count = 0
            recall_top_score = 0.0
        else:
            recall_context = recall_data.get("context", "")
            recall_mem_count = recall_data.get("memory_count", 0)
            recall_top_score = recall_data.get("top_score", 0.0)
            recall_token_count = len(recall_context) // 4

        recall_len = len(recall_context)
        would_inject = recall_top_score >= 5.0 and recall_len > 0 and len(query) >= 10

        print(f"  Recall: {recall_len} chars, ~{recall_token_count} tokens, {recall_mem_count} memories, "
              f"top_score={recall_top_score:.3f}, would_inject={would_inject}",
              file=sys.stderr)

        # Step 2: Send through GATEWAY (recall ON)
        payload = make_payload(query)
        gw_resp, gw_time, gw_err = send_request(GATEWAY, payload)
        gw_text = extract_assistant_text(gw_resp) if not gw_err else ""
        gw_usage = extract_usage(gw_resp) if not gw_err else {}

        print(f"  Gateway: {gw_time:.1f}s, prompt={gw_usage.get('prompt_tokens',0)} tokens, "
              f"completion={gw_usage.get('completion_tokens',0)} tokens",
              file=sys.stderr)

        # Step 3: Send DIRECT to Ollama (recall OFF)
        # Wait a moment to avoid the throttle cache affecting this
        direct_resp, direct_time, direct_err = send_request(DIRECT, payload)
        direct_text = extract_assistant_text(direct_resp) if not direct_err else ""
        direct_usage = extract_usage(direct_resp) if not direct_err else {}

        print(f"  Direct:  {direct_time:.1f}s, prompt={direct_usage.get('prompt_tokens',0)} tokens, "
              f"completion={direct_usage.get('completion_tokens',0)} tokens",
              file=sys.stderr)

        # Step 4: Compare
        prompt_overhead = gw_usage.get("prompt_tokens", 0) - direct_usage.get("prompt_tokens", 0)
        latency_overhead = gw_time - direct_time

        # Does the gateway response reference Cortex memory content?
        overlap = keyword_overlap(recall_context, gw_text)

        # Is the gateway response more detailed / different from direct?
        response_diff_overlap = keyword_overlap(gw_text, direct_text)

        result = {
            "test_id": test_id,
            "query": query,
            "description": test["description"],
            "expect_recall": test["expect_recall"],
            "recall": {
                "chars": recall_len,
                "tokens": recall_token_count,
                "memories": recall_mem_count,
                "top_score": round(recall_top_score, 3),
                "would_inject": would_inject,
            },
            "gateway": {
                "time_s": round(gw_time, 2),
                "prompt_tokens": gw_usage.get("prompt_tokens", 0),
                "completion_tokens": gw_usage.get("completion_tokens", 0),
                "total_tokens": gw_usage.get("total_tokens", 0),
                "response_chars": len(gw_text),
                "error": gw_err,
            },
            "direct": {
                "time_s": round(direct_time, 2),
                "prompt_tokens": direct_usage.get("prompt_tokens", 0),
                "completion_tokens": direct_usage.get("completion_tokens", 0),
                "total_tokens": direct_usage.get("total_tokens", 0),
                "response_chars": len(direct_text),
                "error": direct_err,
            },
            "comparison": {
                "prompt_token_overhead": prompt_overhead,
                "latency_overhead_s": round(latency_overhead, 2),
                "recall_to_response_overlap": round(overlap, 3),
                "gateway_vs_direct_response_overlap": round(response_diff_overlap, 3),
            },
        }
        results.append(result)

        print(f"  Overhead: +{prompt_overhead} prompt tokens, +{latency_overhead:.2f}s", file=sys.stderr)
        print(f"  Recall->Response overlap: {overlap:.3f}", file=sys.stderr)
        print(f"  GW vs Direct response overlap: {response_diff_overlap:.3f}", file=sys.stderr)

    # Summary
    print(f"\n{'='*60}", file=sys.stderr)
    print(f"SUMMARY", file=sys.stderr)
    print(f"{'='*60}", file=sys.stderr)

    total_overhead_tokens = sum(r["comparison"]["prompt_token_overhead"] for r in results)
    total_latency = sum(r["comparison"]["latency_overhead_s"] for r in results)
    avg_recall_overlap = sum(r["comparison"]["recall_to_response_overlap"] for r in results) / len(results)

    print(f"  Total prompt token overhead: {total_overhead_tokens} tokens across {len(results)} tests",
          file=sys.stderr)
    print(f"  Total latency overhead: {total_latency:.2f}s", file=sys.stderr)
    print(f"  Avg recall->response overlap: {avg_recall_overlap:.3f}", file=sys.stderr)

    # Verdict
    recall_tests = [r for r in results if r["expect_recall"]]
    non_recall_tests = [r for r in results if not r["expect_recall"]]

    recall_fired_correctly = all(r["recall"]["would_inject"] for r in recall_tests)
    non_recall_blocked = all(not r["recall"]["would_inject"] for r in non_recall_tests if r["test_id"] != "trivial")
    trivial_skipped = not results[3]["recall"]["would_inject"]  # test index 3 = "ok"

    print(f"\n  Recall fires when expected: {recall_fired_correctly}", file=sys.stderr)
    print(f"  Non-relevant queries blocked: {non_recall_blocked}", file=sys.stderr)
    print(f"  Trivial turn skipped: {trivial_skipped}", file=sys.stderr)

    # Score breakdown
    print(f"\n  Top scores per test:", file=sys.stderr)
    for r in results:
        print(f"    {r['test_id']:20s} top={r['recall']['top_score']:.3f} "
              f"inject={'YES' if r['recall']['would_inject'] else 'no':3s} "
              f"overhead=+{r['comparison']['prompt_token_overhead']}tok "
              f"+{r['comparison']['latency_overhead_s']:.2f}s",
              file=sys.stderr)

    report = {
        "results": results,
        "summary": {
            "total_prompt_token_overhead": total_overhead_tokens,
            "total_latency_overhead_s": round(total_latency, 2),
            "avg_recall_to_response_overlap": round(avg_recall_overlap, 3),
            "recall_fires_when_expected": recall_fired_correctly,
            "non_relevant_blocked": non_recall_blocked,
            "trivial_turn_skipped": trivial_skipped,
        },
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    run_test()