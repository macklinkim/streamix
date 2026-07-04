// Load the live-list API through the BFF (Connect protocol). §1.3 target:
// p95 < 100ms (sized host, Redis cache hit). Locally this is a smaller run and
// the numbers are an accepted deviation (no dedicated list cache yet).
import http from "k6/http";
import { check } from "k6";

const BFF = __ENV.BFF_URL || "http://localhost:8080";

export const options = {
  vus: Number(__ENV.VUS) || 50,
  duration: __ENV.DURATION || "20s",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    // report-only locally; enforced on the sized host (§8.0)
    "http_req_duration{expected_response:true}": ["p(95)<100"],
  },
};

const headers = { "Content-Type": "application/json" };

export default function () {
  const res = http.post(`${BFF}/channel.v1.ChannelService/ListLive`, "{}", { headers });
  check(res, { "status 200": (r) => r.status === 200 });
}
