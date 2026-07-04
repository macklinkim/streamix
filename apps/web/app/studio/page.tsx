"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Code, ConnectError } from "@connectrpc/connect";
import { channelClient } from "@/lib/connect";
import { useAuth } from "@/lib/auth-store";
import { Field, inputCls } from "@/components/field";

const schema = z.object({
  title: z.string().min(1, "제목을 입력하세요").max(140),
  slug: z
    .string()
    .min(3, "3자 이상")
    .max(50)
    .regex(/^[a-z0-9-]+$/, "영소문자·숫자·하이픈만 사용하세요"),
  category: z.string().max(50).optional(),
});
type Form = z.infer<typeof schema>;

const rtmpBase = process.env.NEXT_PUBLIC_RTMP_URL ?? "rtmp://localhost:1935/live";

export default function StudioPage() {
  const { token, ready } = useAuth();
  const [result, setResult] = useState<{ slug: string; streamKey: string } | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(schema) });

  if (ready && !token) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <p className="text-zinc-300">방송을 시작하려면 로그인이 필요합니다.</p>
        <Link href="/login" className="mt-3 inline-block font-medium text-accent hover:underline">
          로그인하기
        </Link>
      </div>
    );
  }

  if (result) {
    return (
      <div className="mx-auto max-w-lg py-12">
        <h1 className="mb-2 text-2xl font-bold tracking-tight">방송 설정 완료</h1>
        <p className="mb-6 text-sm text-zinc-400">
          OBS에 아래 서버/스트림 키를 입력하고 송출하세요. 키는 한 번만 표시됩니다.
        </p>
        <dl className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 font-mono text-sm">
          <div>
            <dt className="text-xs uppercase text-zinc-500">서버</dt>
            <dd className="break-all text-zinc-100">{rtmpBase}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">스트림 키</dt>
            <dd className="break-all text-accent">{result.streamKey}</dd>
          </div>
        </dl>
        <Link
          href={`/watch/${result.slug}`}
          className="mt-6 inline-block rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
        >
          내 방송 보기
        </Link>
      </div>
    );
  }

  const onSubmit = handleSubmit(async (data) => {
    try {
      const res = await channelClient.createChannel(data, {
        headers: { authorization: `Bearer ${token}` },
      });
      setResult({ slug: res.channel!.slug, streamKey: res.streamKey });
    } catch (e) {
      const taken = e instanceof ConnectError && e.code === Code.AlreadyExists;
      setError("root", {
        message: taken ? "이미 사용 중인 slug입니다." : "채널 생성에 실패했습니다.",
      });
    }
  });

  return (
    <div className="mx-auto max-w-lg py-12">
      <h1 className="mb-6 text-2xl font-bold tracking-tight">방송 설정</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="방송 제목" error={errors.title?.message}>
          <input className={inputCls} placeholder="오늘의 방송" {...register("title")} />
        </Field>
        <Field label="채널 주소 (slug)" error={errors.slug?.message}>
          <input className={inputCls} placeholder="my-channel" {...register("slug")} />
        </Field>
        <Field label="카테고리" error={errors.category?.message}>
          <input className={inputCls} placeholder="저스트 채팅" {...register("category")} />
        </Field>
        {errors.root && <p className="text-sm text-live">{errors.root.message}</p>}
        <button
          type="submit"
          disabled={isSubmitting}
          className="h-10 rounded-md bg-accent font-semibold text-white transition-colors hover:bg-accent-hover active:scale-[0.99] disabled:opacity-50"
        >
          {isSubmitting ? "생성 중…" : "채널 만들고 스트림 키 받기"}
        </button>
      </form>
    </div>
  );
}
