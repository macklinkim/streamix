"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConnectError } from "@connectrpc/connect";
import { authClient } from "@/lib/connect";
import { setToken } from "@/lib/auth";

// Minimal login (Phase 4 adds signup, validation UI, refresh). Enough to obtain
// an access token so authed features (chat) work end-to-end.
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await authClient.login({ email, password });
      setToken(res.accessToken);
      router.push("/");
    } catch (err) {
      setError(
        err instanceof ConnectError ? "이메일 또는 비밀번호가 올바르지 않습니다." : "로그인 실패",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm py-16">
      <h1 className="mb-6 text-2xl font-bold tracking-tight">로그인</h1>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-zinc-400">이메일</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="h-10 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm focus:border-accent focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-zinc-400">비밀번호</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="h-10 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm focus:border-accent focus:outline-none"
          />
        </label>
        {error && <p className="text-sm text-live">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="h-10 rounded-md bg-accent font-semibold text-white transition-colors hover:bg-accent-hover active:scale-[0.99] disabled:opacity-50"
        >
          {busy ? "로그인 중…" : "로그인"}
        </button>
      </form>
    </div>
  );
}
