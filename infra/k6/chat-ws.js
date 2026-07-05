// WebSocket chat fan-out load rig (§8.0). N viewers join one room; each also
// sends periodically. Fan-out latency = client receive time - server publish
// time (wire sentAtMs). §1.3 target: p95 < 300ms @ 1,000/channel on the sized
// host; local runs use fewer VUs and are an accepted deviation.
import ws from "k6/ws";
import http from "k6/http";
import { check } from "k6";
import { Trend, Counter } from "k6/metrics";

const BFF = __ENV.BFF_URL || "http://localhost:8080";
const WS = __ENV.WS_URL || "ws://localhost:8080";
const SLUG = __ENV.SLUG || "e2e-live";

const fanout = new Trend("chat_fanout_ms", true);
const received = new Counter("chat_received");

export const options = {
  vus: Number(__ENV.VUS) || 100,
  duration: __ENV.DURATION || "20s",
  thresholds: {
    // report-only locally; enforced on the sized host (§8.0)
    chat_fanout_ms: ["p(95)<300"],
  },
};

export function setup() {
  const h = { "Content-Type": "application/json" };
  const login = http.post(
    `${BFF}/user.v1.AuthService/Login`,
    JSON.stringify({ email: "e2e@streamix.test", password: "e2epassword123" }),
    { headers: h },
  );
  const token = JSON.parse(login.body).accessToken;
  const ch = http.post(
    `${BFF}/channel.v1.ChannelService/GetChannel`,
    JSON.stringify({ slug: SLUG }),
    { headers: h },
  );
  const channelId = JSON.parse(ch.body).channel.id;
  return { token, channelId };
}

export default function (data) {
  const url = `${WS}/ws?channelId=${data.channelId}&token=${data.token}`;
  const res = ws.connect(url, {}, (socket) => {
    socket.on("open", () => {
      socket.setInterval(
        () => socket.send(JSON.stringify({ type: "send", text: `load-${Date.now()}` })),
        2500,
      );
      socket.setTimeout(() => socket.close(), 18000);
    });
    socket.on("message", (raw) => {
      const m = JSON.parse(raw);
      // BFF may coalesce bursts into {type:"batch", items:[...]} (M4); count each.
      const items = m.type === "batch" ? m.items : [m];
      for (const it of items) {
        if (it.sentAtMs) {
          fanout.add(Date.now() - it.sentAtMs);
          received.add(1);
        }
      }
    });
  });
  check(res, { "ws 101": (r) => r && r.status === 101 });
}
