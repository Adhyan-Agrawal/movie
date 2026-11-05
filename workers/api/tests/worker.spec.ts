import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API_LIMITS } from "@lumora/api-contract";

describe("Worker security envelope", () => {
  it("serves health only with exact-origin CORS reflection", async () => {
    const response = await SELF.fetch("http://example.com/v1/health", {
      headers: { origin: "http://localhost:3000" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("rejects an untrusted origin without reflecting it", async () => {
    const response = await SELF.fetch("http://example.com/v1/health", {
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects oversized JSON before parsing it", async () => {
    const response = await SELF.fetch("http://example.com/v1/reports/playback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x".repeat(API_LIMITS.bodyBytes + 1) }),
    });
    expect(response.status).toBe(413);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("body_too_large");
  });

  it("rejects URLs and credential-like data in anonymous reports", async () => {
    const response = await SELF.fetch("http://example.com/v1/reports/playback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "failed at https://provider.example/?token=secret" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("validation_error");
  });
});
