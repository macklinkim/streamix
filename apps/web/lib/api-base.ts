// Base URLs for the BFF. Kept dependency-free so both the Connect transport
// and the cookie-session fetch helpers can import it without a cycle.
export const bffUrl = process.env.NEXT_PUBLIC_BFF_URL ?? "http://localhost:8080";
export const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";
