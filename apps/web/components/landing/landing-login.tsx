"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { TwitchLogo, Lightning } from "@phosphor-icons/react";
import { apiLogin, AuthError } from "@/lib/session";
import { useAuth } from "@/lib/auth-store";
import { hideLandingForToday } from "@/lib/landing-visibility";

const schema = z.object({
  email: z.string().email("올바른 아이디(이메일)를 입력하세요"),
  password: z.string().min(8, "비밀번호는 8자 이상"),
});
type Form = z.infer<typeof schema>;

const field =
  "w-full rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-100 " +
  "placeholder:text-zinc-500 outline-none transition-shadow duration-200 " +
  "focus:border-[#9146FF]/70 focus:shadow-[0_0_0_1px_#9146FF,0_0_22px_-2px_#9146FF]";

export function LandingLogin({ onDone }: { onDone: () => void }) {
  const setSession = useAuth((s) => s.setSession);
  const [dismissToday, setDismissToday] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(schema) });

  const toggleDismiss = (checked: boolean) => {
    setDismissToday(checked);
    if (checked) hideLandingForToday();
    else window.localStorage.removeItem("streamix_landing_hidden_until");
  };

  const onSubmit = handleSubmit(async (data) => {
    try {
      const res = await apiLogin(data);
      setSession(res.accessToken, res.user);
      onDone();
    } catch (e) {
      const rate = e instanceof AuthError && e.status === 429;
      setError("root", {
        message: rate ? "잠시 후 다시 시도하세요." : "아이디 또는 비밀번호가 올바르지 않습니다.",
      });
    }
  });

  return (
    <div className="w-[min(92vw,26rem)] rounded-2xl border border-white/10 bg-zinc-950/50 p-8 shadow-2xl backdrop-blur-xl">
      <div className="mb-7 text-center">
        <p className="mb-2 flex items-center justify-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.35em] text-[#9146FF]">
          <Lightning weight="fill" className="size-3.5" />
          live streaming
        </p>
        <h1 className="text-4xl font-black tracking-tight text-white">STREAMIX</h1>
        <p className="mt-2 text-sm tracking-wide text-zinc-400">천을 찢고 들어오세요.</p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label className="text-xs font-medium uppercase tracking-widest text-zinc-500">
          아이디
        </label>
        <input
          type="email"
          autoComplete="email"
          placeholder="you@streamix.tv"
          className={field}
          {...register("email")}
        />
        {errors.email && <p className="-mt-1 text-xs text-red-400">{errors.email.message}</p>}

        <label className="mt-2 text-xs font-medium uppercase tracking-widest text-zinc-500">
          비밀번호
        </label>
        <input
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          className={field}
          {...register("password")}
        />
        {errors.password && <p className="-mt-1 text-xs text-red-400">{errors.password.message}</p>}

        {errors.root && <p className="text-xs text-red-400">{errors.root.message}</p>}

        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-3 h-11 rounded-lg bg-[#9146FF] font-semibold tracking-wide text-white transition-all hover:bg-[#a970ff] hover:shadow-[0_0_24px_-4px_#9146FF] active:scale-[0.99] disabled:opacity-50"
        >
          {isSubmitting ? "접속 중…" : "로그인"}
        </button>
      </form>

      <button
        type="button"
        onClick={onDone}
        className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-[#9146FF]/40 bg-[#9146FF]/10 text-sm font-semibold tracking-wide text-[#c9b3ff] transition-colors hover:bg-[#9146FF]/20"
      >
        <TwitchLogo weight="fill" className="size-4" />
        트위치 계정으로 연동하기
      </button>

      <label className="mt-5 flex cursor-pointer items-center gap-2 text-xs text-zinc-400 select-none">
        <input
          type="checkbox"
          checked={dismissToday}
          onChange={(e) => toggleDismiss(e.target.checked)}
          className="size-4 rounded border-white/20 bg-white/5 accent-[#9146FF]"
        />
        오늘은 보지 않기 (자정에 초기화)
      </label>

      <button
        type="button"
        onClick={onDone}
        className="mt-2 w-full text-center text-xs text-zinc-500 transition-colors hover:text-zinc-300"
      >
        그냥 둘러보기 →
      </button>
    </div>
  );
}
