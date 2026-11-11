"use client";

import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { passwordSchema } from "@streamix/schemas";
import { apiRegister, AuthError } from "@/lib/session";
import { Field, inputCls } from "@/components/field";

const schema = z.object({
  displayName: z.string().min(2, "2자 이상 입력하세요").max(20),
  email: z.string().email("올바른 이메일을 입력하세요"),
  password: passwordSchema,
});
type Form = z.infer<typeof schema>;

export default function SignupPage() {
  const [submitted, setSubmitted] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (data) => {
    try {
      await apiRegister(data);
      reset();
      setSubmitted(true);
    } catch (e) {
      const exists = e instanceof AuthError && e.status === 409;
      setError("root", { message: exists ? "이미 가입된 이메일입니다." : "회원가입 실패" });
    }
  });

  return (
    <div className="mx-auto max-w-sm py-16">
      <h1 className="mb-6 text-2xl font-bold tracking-tight">회원가입</h1>
      {submitted ? (
        <div
          role="status"
          className="rounded-lg border border-accent/40 bg-accent/10 p-5 text-sm text-zinc-200"
        >
          <p className="font-semibold text-white">가입 신청이 접수됐습니다.</p>
          <p className="mt-2">관리자 승인 후 로그인할 수 있습니다.</p>
          <Link href="/login" className="mt-4 inline-block font-medium text-accent underline">
            로그인으로 이동
          </Link>
        </div>
      ) : (
        <>
          <p className="mb-5 text-sm text-zinc-400">가입 신청 후 관리자 승인이 필요합니다.</p>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <Field label="닉네임" error={errors.displayName?.message}>
              <input className={inputCls} {...register("displayName")} />
            </Field>
            <Field label="이메일" error={errors.email?.message}>
              <input
                type="email"
                autoComplete="email"
                className={inputCls}
                {...register("email")}
              />
            </Field>
            <Field label="비밀번호" error={errors.password?.message}>
              <input
                type="password"
                autoComplete="new-password"
                className={inputCls}
                {...register("password")}
              />
            </Field>
            {errors.root && (
              <p role="alert" className="text-sm text-live">
                {errors.root.message}
              </p>
            )}
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
        </>
      )}
    </div>
  );
}
