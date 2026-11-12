"use client";

import { useEffect, useState } from "react";

const EMAIL_KEY = "streamix_saved_email";

export function useLoginPreferences() {
  const [savedEmail, setSavedEmail] = useState("");
  const [rememberId, setRememberId] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);

  useEffect(() => {
    try {
      const email = localStorage.getItem(EMAIL_KEY) ?? "";
      setSavedEmail(email);
      setRememberId(Boolean(email));
    } catch {
      // Storage restrictions must not prevent login.
    }
  }, []);

  function changeRememberId(checked: boolean) {
    setRememberId(checked);
    if (!checked) {
      try {
        localStorage.removeItem(EMAIL_KEY);
      } catch {
        // Login remains available when storage is blocked.
      }
    }
  }

  function saveEmail(email: string) {
    try {
      if (rememberId) localStorage.setItem(EMAIL_KEY, email.trim());
      else localStorage.removeItem(EMAIL_KEY);
    } catch {
      // Remembering an email is optional; session creation still succeeds.
    }
  }

  return { savedEmail, rememberId, rememberMe, changeRememberId, setRememberMe, saveEmail };
}

export function LoginOptions({
  rememberId,
  rememberMe,
  changeRememberId,
  setRememberMe,
}: Pick<
  ReturnType<typeof useLoginPreferences>,
  "rememberId" | "rememberMe" | "changeRememberId" | "setRememberMe"
>) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-zinc-300">
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={rememberId}
          onChange={(event) => changeRememberId(event.target.checked)}
          className="size-4 accent-[#9146FF]"
        />
        아이디 저장
      </label>
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={rememberMe}
          onChange={(event) => setRememberMe(event.target.checked)}
          className="size-4 accent-[#9146FF]"
        />
        자동 로그인
      </label>
    </div>
  );
}
