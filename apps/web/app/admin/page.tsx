"use client";

import { useEffect, useState } from "react";
import type { User } from "@streamix/proto";
import { authClient } from "@/lib/connect";
import { useAuth } from "@/lib/auth-store";

export default function AdminPage() {
  const { ready, token, user } = useAuth();
  const [pending, setPending] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!ready || !user?.isAdmin || !token) return;
    let cancelled = false;
    authClient
      .listPendingUsers({}, { headers: { authorization: `Bearer ${token}` } })
      .then((res) => {
        if (!cancelled) setPending(res.users);
      })
      .catch(() => {
        if (!cancelled) setError("가입 신청을 불러오지 못했습니다. 새로고침 후 다시 시도하세요.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, token, user?.isAdmin]);

  const approve = async (id: string) => {
    if (!token) return;
    setBusyId(id);
    setError("");
    try {
      await authClient.approveUser(
        { userId: id },
        { headers: { authorization: `Bearer ${token}` } },
      );
      setPending((users) => users.filter((item) => item.id !== id));
    } catch {
      setError("승인하지 못했습니다. 다시 시도하세요.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl py-8">
      <h1 className="text-2xl font-bold">가입 승인</h1>
      {!ready || (user?.isAdmin && loading) ? (
        <p role="status" className="mt-6 text-sm text-zinc-400">
          신청 목록을 불러오는 중…
        </p>
      ) : !user?.isAdmin ? (
        <p role="alert" className="mt-6 text-sm text-zinc-300">
          관리자만 접근할 수 있습니다.
        </p>
      ) : (
        <>
          {error && (
            <p role="alert" className="mt-4 text-sm text-red-400">
              {error}
            </p>
          )}
          {pending.length === 0 ? (
            <p role="status" className="mt-6 text-sm text-zinc-400">
              {error ? "목록을 다시 불러오려면 새로고침하세요." : "대기 중인 가입 신청이 없습니다."}
            </p>
          ) : (
            <ul className="mt-6 divide-y divide-zinc-800 rounded-lg border border-zinc-800">
              {pending.map((applicant) => (
                <li
                  key={applicant.id}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-white">{applicant.displayName}</p>
                    <p className="break-all text-sm text-zinc-400">{applicant.email}</p>
                  </div>
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void approve(applicant.id)}
                    className="min-h-11 rounded-md bg-accent px-5 text-sm font-semibold text-white hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
                  >
                    {busyId === applicant.id ? "승인 중…" : "승인"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
