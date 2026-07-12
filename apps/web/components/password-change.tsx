"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { isWeakPassword } from "@streamix/schemas";
import { apiChangePassword, AuthError } from "@/lib/session";
import { useAuth } from "@/lib/auth-store";
import { Field, inputCls } from "@/components/field";

const schema = z
  .object({
    currentPassword: z.string().min(1, "현재 비밀번호를 입력하세요"),
    newPassword: z
      .string()
      .min(12, "비밀번호는 12자 이상이어야 합니다")
      .refine((p) => !isWeakPassword(p), "너무 흔하거나 예측하기 쉬운 비밀번호입니다"),
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, {
    path: ["confirm"],
    message: "비밀번호가 일치하지 않습니다",
  });
type Form = z.infer<typeof schema>;

export function PasswordChangeForm() {
  const router = useRouter();
  const token = useAuth((s) => s.token);
  const clear = useAuth((s) => s.clear);
  const [done, setDone] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (data) => {
    try {
      await apiChangePassword(token, {
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
      });
      // Server revoked every session — drop local auth and bounce to login.
      setDone(true);
      clear();
      setTimeout(() => router.push("/login"), 1500);
    } catch (e) {
      if (e instanceof AuthError && e.status === 401) {
        setError("currentPassword", { message: "현재 비밀번호가 올바르지 않습니다" });
      } else if (e instanceof AuthError && e.status === 400) {
        setError("newPassword", { message: "비밀번호 정책을 확인하세요 (12자 이상)" });
      } else {
        setError("confirm", { message: "변경에 실패했습니다. 다시 시도하세요" });
      }
    }
  });

  if (done) {
    return (
      <p className="text-sm text-emerald-400">
        비밀번호를 변경했습니다. 모든 기기에서 로그아웃됩니다. 다시 로그인하세요…
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <Field label="현재 비밀번호" error={errors.currentPassword?.message}>
        <input
          type="password"
          autoComplete="current-password"
          className={inputCls}
          {...register("currentPassword")}
        />
      </Field>
      <Field label="새 비밀번호" error={errors.newPassword?.message}>
        <input
          type="password"
          autoComplete="new-password"
          className={inputCls}
          {...register("newPassword")}
        />
      </Field>
      <Field label="새 비밀번호 확인" error={errors.confirm?.message}>
        <input
          type="password"
          autoComplete="new-password"
          className={inputCls}
          {...register("confirm")}
        />
      </Field>
      <button
        type="submit"
        disabled={isSubmitting}
        className="h-9 rounded-md bg-accent px-4 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
      >
        {isSubmitting ? "변경 중…" : "비밀번호 변경"}
      </button>
    </form>
  );
}
