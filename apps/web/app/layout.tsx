import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { SiteHeader } from "@/components/site-header";
import { Sidebar } from "@/components/sidebar";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Streamix — 라이브 스트리밍",
  description: "gRPC 기반 실시간 방송 플랫폼",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-[100dvh] bg-zinc-950 font-sans text-zinc-100 antialiased">
        <Providers>
          <SiteHeader />
          <div className="mx-auto flex max-w-[1600px]">
            <Sidebar />
            <main className="min-w-0 flex-1 px-4 py-6 md:px-6">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
