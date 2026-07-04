import { createServer } from "node:http2";
import type { ConnectRouter } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { ChatService } from "@streamix/proto";
import { chatService } from "./chat.service.js";
import { env } from "./env.js";

function routes(router: ConnectRouter) {
  router.service(ChatService, chatService);
}

const server = createServer(connectNodeAdapter({ routes }));

server.listen(env.PORT, () => {
  console.log(`svc-chat (connect h2c) listening on :${env.PORT}`);
});
