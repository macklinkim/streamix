import Fastify from "fastify";
import { loadEnv } from "@streamix/config";

const env = loadEnv();
const app = Fastify({ logger: true });

// Control-plane entry point (ADR-1 / §5.1). Connect-Web + WS handlers land here
// in Phase 2; Phase 0 only proves the process boots and reports health.
app.get("/health", async () => ({ status: "ok", service: "bff" }));

const start = async () => {
  try {
    const address = await app.listen({ port: env.PORT, host: "0.0.0.0" });
    app.log.info(`bff listening on ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
