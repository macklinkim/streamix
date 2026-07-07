"use client";

import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter } from "next/navigation";
import { apiLogin } from "@/lib/session";
import { useAuth } from "@/lib/auth-store";
import { Field, inputCls } from "@/components/field";

const schema = z.object({
  email: z.string().email("올바른 이메일을 입력하세요"),
  password: z.string().min(8, "비밀번호는 8자 이상이어야 합니다"),
});
type Form = z.infer<typeof schema>;

export default function LoginPage() {
  const router = useRouter();
  const setSession = useAuth((s) => s.setSession);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (data) => {
    try {
      const res = await apiLogin(data);
      setSession(res.accessToken, res.user);
      router.push("/");
    } catch {
      setError("root", { message: "이메일 또는 비밀번호가 올바르지 않습니다." });
    }
  });

  return (
    <div className="mx-auto max-w-sm py-16">
      <h1 className="mb-6 text-2xl font-bold tracking-tight">로그인</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="이메일" error={errors.email?.message}>
          <input type="email" autoComplete="email" className={inputCls} {...register("email")} />
        </Field>
        <Field label="비밀번호" error={errors.password?.message}>
          <input
            type="password"
            autoComplete="current-password"
            className={inputCls}
            {...register("password")}
          />
        </Field>
        {errors.root && <p className="text-sm text-live">{errors.root.message}</p>}
        <button
          type="submit"
          disabled={isSubmitting}
          className="h-10 rounded-md bg-accent font-semibold text-white transition-colors hover:bg-accent-hover active:scale-[0.99] disabled:opacity-50"
        >
          {isSubmitting ? "로그인 중…" : "로그인"}
        </button>
      </form>
      <p className="mt-4 text-sm text-zinc-400">
        아직 계정이 없나요?{" "}
        <Link href="/signup" className="font-medium text-accent hover:underline">
          회원가입
        </Link>
      </p>
    </div>
  );
}
