import { describe, expect, it } from "vitest";
import { LEGACY_SERVICE_WORKER } from "./legacyServiceWorker";

describe("LEGACY_SERVICE_WORKER", () => {
  it("activates immediately and removes the old PWA cache owner", () => {
    expect(LEGACY_SERVICE_WORKER).toContain("self.skipWaiting()");
    expect(LEGACY_SERVICE_WORKER).toContain("self.registration.unregister()");
    expect(LEGACY_SERVICE_WORKER).toContain("self.caches.delete");
    expect(LEGACY_SERVICE_WORKER).toContain("client.navigate(client.url)");
  });
});
