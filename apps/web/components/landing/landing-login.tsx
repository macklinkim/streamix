"use client";
import Link from "next/link";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { loginPasswordSchema } from "@streamix/schemas";
import { TwitchLogo, Lightning } from "@phosphor-icons/react";
import { apiLogin, AuthError } from "@/lib/session";
import { bffUrl } from "@/lib/api-base";
import { useAuth } from "@/lib/auth-store";
import { LoginOptions, useLoginPreferences } from "@/components/login-options";

const schema = z.object({
  email: z.string().email("올바른 아이디(이메일)를 입력하세요"),
  password: loginPasswordSchema,
});
type Form = z.infer<typeof schema>;

const field =
  "w-full rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-100 " +
  "placeholder:text-zinc-500 outline-none transition-shadow duration-200 " +
  "focus:border-[#9146FF]/70 focus:shadow-[0_0_0_1px_#9146FF,0_0_22px_-2px_#9146FF]";

export function LandingLogin({ onDone }: { onDone: () => void }) {
  const setSession = useAuth((s) => s.setSession);
  const preferences = useLoginPreferences();
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(schema) });

  useEffect(() => {
    setValue("email", preferences.savedEmail);
  }, [preferences.savedEmail, setValue]);

  const onSubmit = handleSubmit(async (data) => {
    try {
      const res = await apiLogin({ ...data, rememberMe: preferences.rememberMe });
      preferences.saveEmail(data.email);
      setSession(res.accessToken, res.user);
      onDone();
    } catch (e) {
      const rate = e instanceof AuthError && e.status === 429;
      const pending = e instanceof AuthError && e.status === 403 && e.code === "approval pending";
      setError("root", {
        message: pending
          ? "관리자 승인 대기 중입니다."
          : rate
            ? "잠시 후 다시 시도하세요."
            : "아이디 또는 비밀번호가 올바르지 않습니다.",
      });
    }
  });

  return (
    <div className="w-[min(92vw,26rem)] rounded-2xl border border-[#9146FF]/25 bg-zinc-950/70 p-8 shadow-[0_0_60px_-15px_rgba(145,70,255,0.6)] backdrop-blur-xl">
      <div className="mb-7 text-center">
        <p className="mb-2 flex items-center justify-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.35em] text-[#9146FF]">
          <Lightning weight="fill" className="size-3.5" />
          live streaming
        </p>
        <h1 id="landing-title" className="text-4xl font-black tracking-tight text-white">
          STREAMIX
        </h1>
        <p className="mt-2 text-sm tracking-wide text-zinc-400">천을 찢고 들어오세요.</p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label
          htmlFor="landing-email"
          className="text-xs font-medium uppercase tracking-widest text-zinc-500"
        >
          아이디
        </label>
        <input
          id="landing-email"
          type="email"
          autoComplete="email"
          placeholder="you@streamix.tv"
          className={field}
          {...register("email")}
        />
        {errors.email && <p className="-mt-1 text-xs text-red-400">{errors.email.message}</p>}

        <label
          htmlFor="landing-password"
          className="mt-2 text-xs font-medium uppercase tracking-widest text-zinc-500"
        >
          비밀번호
        </label>
        <input
          id="landing-password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          className={field}
          {...register("password")}
        />
        {errors.password && <p className="-mt-1 text-xs text-red-400">{errors.password.message}</p>}

        <LoginOptions {...preferences} />
        {errors.root && (
          <p role="alert" className="text-xs text-red-400">
            {errors.root.message}
          </p>
        )}

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
        onClick={() => {
          window.location.href = `${bffUrl}/auth/twitch?rememberMe=${preferences.rememberMe ? "1" : "0"}`;
        }}
        className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-[#9146FF]/40 bg-[#9146FF]/10 text-sm font-semibold tracking-wide text-[#c9b3ff] transition-colors hover:bg-[#9146FF]/20"
      >
        <TwitchLogo weight="fill" className="size-4" />
        트위치 계정으로 연동하기
      </button>

      <Link
        href="/signup"
        onClick={onDone}
        className="mt-3 flex h-11 w-full items-center justify-center rounded-lg border border-[#9146FF]/40 text-sm font-semibold tracking-wide text-[#c9b3ff] transition-colors hover:bg-[#9146FF]/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c9b3ff]"
      >
        회원가입
      </Link>

      <button
        type="button"
        onClick={onDone}
        className="mt-3 h-11 w-full rounded-lg bg-[#9146FF] font-semibold tracking-wide text-white transition-all hover:bg-[#a970ff] hover:shadow-[0_0_24px_-4px_#9146FF] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c9b3ff] active:scale-[0.99]"
      >
        그냥 둘러보기
      </button>
    </div>
  );
}
