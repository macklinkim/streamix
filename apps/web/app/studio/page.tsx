"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Code, ConnectError } from "@connectrpc/connect";
import { Copy, ArrowsClockwise, Check } from "@phosphor-icons/react";
import type { Channel } from "@streamix/proto";
import { channelClient } from "@/lib/connect";
import { useAuth } from "@/lib/auth-store";
import { Field, inputCls } from "@/components/field";
import { ScreenBroadcast } from "@/components/broadcast";

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

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      aria-label="복사"
      className="shrink-0 rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
    >
      {copied ? <Check size={16} className="text-accent" /> : <Copy size={16} />}
    </button>
  );
}

function CreateChannelForm({
  token,
  onCreated,
}: {
  token: string;
  onCreated: (streamKey: string) => void;
}) {
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (data) => {
    try {
      const res = await channelClient.createChannel(data, {
        headers: { authorization: `Bearer ${token}` },
      });
      onCreated(res.streamKey);
      await queryClient.invalidateQueries({ queryKey: ["my-channel"] });
    } catch (e) {
      const taken = e instanceof ConnectError && e.code === Code.AlreadyExists;
      setError("root", {
        message: taken ? "이미 사용 중인 slug입니다." : "채널 생성에 실패했습니다.",
      });
    }
  });

  return (
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
  );
}

function ChannelPanel({
  channel,
  token,
  initialKey,
}: {
  channel: Channel;
  token: string;
  // Create-time plaintext key, so a fresh channel can broadcast immediately.
  initialKey: string;
}) {
  // The key is only shown in plaintext at create/rotate time; otherwise masked.
  const [streamKey, setStreamKey] = useState(initialKey);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState("");

  async function rotate() {
    setRotating(true);
    setRotateError("");
    try {
      const res = await channelClient.rotateStreamKey(
        {},
        { headers: { authorization: `Bearer ${token}` } },
      );
      setStreamKey(res.streamKey);
    } catch {
      setRotateError("키 재발급에 실패했습니다.");
    } finally {
      setRotating(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold tracking-tight">{channel.title}</h1>
          <p className="mt-0.5 text-sm text-zinc-400">
            /{channel.slug}
            {channel.isLive && <span className="ml-2 font-mono text-live">● LIVE</span>}
          </p>
        </div>
        <Link
          href={`/watch/${channel.slug}`}
          className="shrink-0 rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100"
        >
          내 방송 보기
        </Link>
      </div>

      {streamKey ? (
        <ScreenBroadcast streamKey={streamKey} />
      ) : (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <h2 className="text-sm font-semibold text-zinc-100">브라우저로 화면 방송</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            화면 방송을 하려면 스트림 키가 필요합니다. 아래에서 키를 재발급하세요.
          </p>
        </div>
      )}

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h2 className="text-sm font-semibold text-zinc-100">OBS로 송출</h2>
        <dl className="mt-3 space-y-3 font-mono text-sm">
          <div>
            <dt className="text-xs uppercase text-zinc-500">서버</dt>
            <dd className="flex items-center gap-1">
              <span className="break-all text-zinc-100">{rtmpBase}</span>
              <CopyButton value={rtmpBase} />
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-500">스트림 키</dt>
            {streamKey ? (
              <dd className="flex items-center gap-1">
                <span className="break-all text-accent">{streamKey}</span>
                <CopyButton value={streamKey} />
              </dd>
            ) : (
              <dd className="text-zinc-500">
                보안을 위해 저장된 키는 다시 보여드릴 수 없습니다. 잃어버렸다면 재발급하세요.
              </dd>
            )}
          </div>
        </dl>
        <button
          onClick={() => void rotate()}
          disabled={rotating}
          className="mt-3 flex h-9 items-center gap-1.5 rounded-md border border-zinc-800 px-3 text-sm text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100 active:scale-[0.98] disabled:opacity-50"
        >
          <ArrowsClockwise size={15} className={rotating ? "animate-spin" : ""} />
          {rotating ? "재발급 중…" : "스트림 키 재발급"}
        </button>
        {streamKey && (
          <p className="mt-2 text-xs text-zinc-500">
            이 키는 지금만 표시됩니다. 재발급하면 이전 키는 즉시 무효화됩니다.
          </p>
        )}
        {rotateError && <p className="mt-2 text-xs text-live">{rotateError}</p>}
      </div>
    </div>
  );
}

export default function StudioPage() {
  const { token, ready } = useAuth();
  const [createdKey, setCreatedKey] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["my-channel"],
    queryFn: async () =>
      (await channelClient.getMyChannel({}, { headers: { authorization: `Bearer ${token}` } }))
        .channel ?? null,
    enabled: ready && !!token,
  });

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

  return (
    <div className="mx-auto max-w-lg py-12">
      {!ready || isLoading ? (
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-1/2 rounded bg-zinc-900" />
          <div className="h-40 rounded-lg bg-zinc-900" />
          <div className="h-40 rounded-lg bg-zinc-900" />
        </div>
      ) : data ? (
        <ChannelPanel channel={data} token={token!} initialKey={createdKey} />
      ) : (
        <>
          <h1 className="mb-6 text-2xl font-bold tracking-tight">방송 설정</h1>
          <CreateChannelForm token={token!} onCreated={setCreatedKey} />
        </>
      )}
    </div>
  );
}
