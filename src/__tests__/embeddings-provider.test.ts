import { afterEach, describe, expect, it, jest } from "@jest/globals";

const ORIGINAL_PROVIDER = process.env.EMBEDDING_PROVIDER;
const ORIGINAL_MODEL = process.env.EMBEDDING_MODEL;
const ORIGINAL_VOYAGE_KEY = process.env.VOYAGE_API_KEY;

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  if (ORIGINAL_PROVIDER === undefined) delete process.env.EMBEDDING_PROVIDER;
  else process.env.EMBEDDING_PROVIDER = ORIGINAL_PROVIDER;
  if (ORIGINAL_MODEL === undefined) delete process.env.EMBEDDING_MODEL;
  else process.env.EMBEDDING_MODEL = ORIGINAL_MODEL;
  if (ORIGINAL_VOYAGE_KEY === undefined) delete process.env.VOYAGE_API_KEY;
  else process.env.VOYAGE_API_KEY = ORIGINAL_VOYAGE_KEY;
});

describe("embedding provider batch boundaries", () => {
  it("rejects a short Voyage sub-batch before later responses can realign the total", async () => {
    process.env.EMBEDDING_PROVIDER = "voyage";
    process.env.EMBEDDING_MODEL = "slice3-voyage-model";
    process.env.VOYAGE_API_KEY = "slice3-test-key";
    const unitVector = [1, ...Array.from({ length: 1023 }, () => 0)];
    const response = (count: number) =>
      new Response(
        JSON.stringify({
          data: Array.from({ length: count }, () => ({
            embedding: unitVector,
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    const fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(31))
      .mockResolvedValueOnce(response(2));
    const { EmbeddingResultError, embedTextsWithMetadata } = await import(
      "../ingestion/embeddings.js"
    );

    await expect(
      embedTextsWithMetadata(
        Array.from({ length: 33 }, (_, index) => `chunk ${index}`)
      )
    ).rejects.toMatchObject({
      name: "EmbeddingResultError",
      code: "embedding_batch_mismatch",
    } satisfies Partial<InstanceType<typeof EmbeddingResultError>>);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("cancels a rejected provider body without reading or logging it", async () => {
    process.env.EMBEDDING_PROVIDER = "voyage";
    process.env.EMBEDDING_MODEL = "slice3-voyage-model";
    process.env.VOYAGE_API_KEY = "slice3-test-key";
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(
          new TextEncoder().encode("slice3-private-provider-body")
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(body, { status: 400 }));
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
    const { embedTextsWithMetadata } = await import(
      "../ingestion/embeddings.js"
    );

    await expect(embedTextsWithMetadata(["one chunk"])).rejects.toMatchObject({
      name: "EmbeddingProviderError",
      code: "embedding_provider_rejected",
      status: 400,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(true);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
      "slice3-private-provider-body"
    );
  });

  it("retries only transient HTTP failures and never logs their bodies", async () => {
    jest.useFakeTimers();
    process.env.EMBEDDING_PROVIDER = "voyage";
    process.env.EMBEDDING_MODEL = "slice3-voyage-model";
    process.env.VOYAGE_API_KEY = "slice3-test-key";
    const fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        new Response("slice3-private-transient-body", { status: 429 })
      );
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
    const { embedTextsWithMetadata } = await import(
      "../ingestion/embeddings.js"
    );

    const pending = embedTextsWithMetadata(["one chunk"]);
    const rejection = expect(pending).rejects.toMatchObject({
      name: "EmbeddingProviderError",
      code: "embedding_provider_unavailable",
      status: 429,
    });
    await jest.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
      "slice3-private-transient-body"
    );
  });

  it.each([
    ["malformed JSON", "{slice3-private-malformed-json"],
    ["missing data", JSON.stringify({ secret: "slice3-private-top-level" })],
  ])("rejects %s without an inner retry", async (_name, body) => {
    process.env.EMBEDDING_PROVIDER = "voyage";
    process.env.EMBEDDING_MODEL = "slice3-voyage-model";
    process.env.VOYAGE_API_KEY = "slice3-test-key";
    const fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(body, { status: 200 }));
    const { embedTextsWithMetadata } = await import(
      "../ingestion/embeddings.js"
    );

    await expect(embedTextsWithMetadata(["one chunk"])).rejects.toMatchObject({
      name: "EmbeddingResultError",
      code: "embedding_result_invalid",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
