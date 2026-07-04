import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { AuthService, ChannelService, ChatService } from "@streamix/proto";
import { env } from "./env.js";

const coreTransport = createGrpcTransport({ baseUrl: env.CORE_URL });
const chatTransport = createGrpcTransport({ baseUrl: env.CHAT_URL });

export const coreAuth = createClient(AuthService, coreTransport);
export const coreChannel = createClient(ChannelService, coreTransport);
export const chat = createClient(ChatService, chatTransport);
