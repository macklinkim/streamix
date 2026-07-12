"use client";

import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter } from "next/navigation";
import { apiLogin, apiRegister, AuthError } from "@/lib/session";
import { useAuth } from "@/lib/auth-store";
import { Field, inputCls } from "@/components/field";

const schema = z.object({
  displayName: z.string().min(2, "2자 이상 입력하세요").max(20),
  email: z.string().email("올바른 이메일을 입력하세요"),
  password: z.string().min(12, "비밀번호는 12자 이상이어야 합니다"),
});
type Form = z.infer<typeof schema>;

export default function SignupPage() {
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
      await apiRegister(data);
      const res = await apiLogin({ email: data.email, password: data.password });
      setSession(res.accessToken, res.user);
      router.push("/");
    } catch (e) {
      const exists = e instanceof AuthError && e.status === 409;
      setError("root", { message: exists ? "이미 가입된 이메일입니다." : "회원가입 실패" });
    }
  });

  return (
    <div className="mx-auto max-w-sm py-16">
      <h1 className="mb-6 text-2xl font-bold tracking-tight">회원가입</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="닉네임" error={errors.displayName?.message}>
          <input className={inputCls} {...register("displayName")} />
        </Field>
        <Field label="이메일" error={errors.email?.message}>
          <input type="email" autoComplete="email" className={inputCls} {...register("email")} />
        </Field>
        <Field label="비밀번호" error={errors.password?.message}>
          <input
            type="password"
            autoComplete="new-password"
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
          {isSubmitting ? "가입 중…" : "회원가입"}
        </button>
      </form>
      <p className="mt-4 text-sm text-zinc-400">
        이미 계정이 있나요?{" "}
        <Link href="/login" className="font-medium text-accent hover:underline">
          로그인
        </Link>
      </p>
    </div>
  );
}
