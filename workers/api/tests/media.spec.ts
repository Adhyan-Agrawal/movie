import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createMediaCapability } from "../src/media";
import { seedAccount } from "./fixtures";

describe("private R2 media capabilities", () => {
  it("serves only the signed prefix and preserves byte-range metadata", async () => {
    const accountId = crypto.randomUUID();
    await seedAccount(env.DB, accountId, "media-range@example.test", { role: "owner" });
    const bytes = Uint8Array.from({ length: 10 }, (_, index) => index);
    await env.MEDIA.put("media/test/video.bin", bytes, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    const capability = await createMediaCapability(env, accountId, "media/test/", 60);
    const response = await SELF.fetch(`${capability.url}video.bin`, {
      headers: { range: "bytes=2-5" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([2, 3, 4, 5]);
  });
});
