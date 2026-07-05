// Slow-consumer isolation rig (M4 / gate G4). Two scenarios share one room:
//   - crowd: N well-behaved viewers; their fan-out p95 is the metric under test.
//   - slow: exactly 1 viewer that busy-blocks in its message handler, so it stops
//     draining its socket and the BFF's per-socket bufferedAmount backs up.
// Pass criterion: the crowd's p95 stays < 300ms even though the slow consumer is
// wedged — i.e. backpressure drops the slow socket instead of stalling the room.
// Local runs use fewer VUs (accepted deviation, §8.0); the sized-host 1,000 VU
// verdict (G4) happens in integration.
import ws from "k6/ws";
import http from "k6/http";
import { check } from "k6";
import { Trend, Counter } from "k6/metrics";

const BFF = __ENV.BFF_URL || "http://localhost:8080";
const WS = __ENV.WS_URL || "ws://localhost:8080";
const SLUG = __ENV.SLUG || "e2e-live";
const VUS = Number(__ENV.VUS) || 100;
const DURATION = __ENV.DURATION || "20s";
const SLOW_BLOCK_MS = Number(__ENV.SLOW_BLOCK_MS) || 300; // per-message stall on the slow VU
const SEND_INTERVAL_MS = Number(__ENV.SEND_INTERVAL_MS) || 2500; // crowd send cadence
const TEXT_BYTES = Number(__ENV.TEXT_BYTES) || 12; // message body size (raise to stress buffers)
const BODY = "x".repeat(Math.max(0, TEXT_BYTES - 6)); // padded payload (svc-chat caps text at 500)

const fanout = new Trend("chat_fanout_ms", true);
const received = new Counter("chat_received");

export const options = {
  scenarios: {
    crowd: { executor: "constant-vus", vus: VUS, duration: DURATION, exec: "crowd" },
    slow: { executor: "constant-vus", vus: 1, duration: DURATION, exec: "slow" },
  },
  thresholds: {
    // Only the crowd is judged; the slow consumer must not degrade it (G4).
    "chat_fanout_ms{scenario:crowd}": ["p(95)<300"],
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

function countMessage(raw) {
  const m = JSON.parse(raw);
  const items = m.type === "batch" ? m.items : [m];
  for (const it of items) {
    if (it.sentAtMs) {
      fanout.add(Date.now() - it.sentAtMs);
      received.add(1);
    }
  }
}

export function crowd(data) {
  const url = `${WS}/ws?channelId=${data.channelId}&token=${data.token}`;
  const res = ws.connect(url, {}, (socket) => {
    socket.on("open", () => {
      socket.setInterval(
        () => socket.send(JSON.stringify({ type: "send", text: `${BODY}-${Date.now()}` })),
        SEND_INTERVAL_MS,
      );
      socket.setTimeout(() => socket.close(), 18000);
    });
    socket.on("message", countMessage);
  });
  check(res, { "ws 101": (r) => r && r.status === 101 });
}

export function slow(data) {
  const url = `${WS}/ws?channelId=${data.channelId}&token=${data.token}`;
  const res = ws.connect(url, {}, (socket) => {
    socket.on("open", () => socket.setTimeout(() => socket.close(), 18000));
    // Busy-block on every frame: the VU stops reading, so the server-side socket
    // buffer fills past BUFFERED_LIMIT and the BFF starts dropping to this socket.
    socket.on("message", () => {
      const end = Date.now() + SLOW_BLOCK_MS;
      while (Date.now() < end) {
        /* intentional spin to wedge the consumer */
      }
    });
  });
  check(res, { "ws 101 (slow)": (r) => r && r.status === 101 });
}
