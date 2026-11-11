import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "prom-client";
import { cspRoutes } from "./csp.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appWithCsp() {
  const app = Fastify();
  apps.push(app);
  await app.register(cspRoutes);
  return app;
}

describe("CSP report boundaries", () => {
  it("collapses arbitrary directives into one metric label", async () => {
    const app = await appWithCsp();
    for (let i = 0; i < 10; i++) {
      const response = await app.inject({
        method: "POST",
        url: "/csp-report",
        payload: { "csp-report": { "effective-directive": `invented-${i}` } },
      });
      expect(response.statusCode).toBe(204);
    }
    const metric = await register.getSingleMetricAsString("streamix_csp_violations_total");
    expect(metric).toContain('directive="other"');
    expect(metric).not.toContain("invented-");
  });

  it("accepts non-string fields and removes URI secrets from logs", async () => {
    const app = await appWithCsp();
    const warn = vi.spyOn(app.log, "warn");
    const response = await app.inject({
      method: "POST",
      url: "/csp-report",
      payload: {
        "csp-report": {
          "effective-directive": ["script-src"],
          "blocked-uri": "https://example.com/script.js?token=secret#fragment",
          "document-uri": "https://example.com/page?session=secret#fragment",
        },
      },
    });
    expect(response.statusCode).toBe(204);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("fragment");
    expect(logged).toContain("https://example.com/script.js");
  });
});
