import { useState } from "react";
import type { FormEvent } from "react";
import { ApiError, login, signup } from "../api";
import type { User } from "../types";
import { AlertIcon, BlobIcon, SpinnerIcon } from "../icons";
import { cx } from "../lib";

interface AuthScreenProps {
  onAuthed: (user: User) => void;
}

const inputCls =
  "w-full border border-neutral-300 bg-page px-3.5 py-2.5 text-sm text-neutral-800 placeholder:text-neutral-400 focus:border-bloop focus:outline-none focus:ring-2 focus:ring-bloop/40";

export function AuthScreen({ onAuthed }: AuthScreenProps) {
  const [tab, setTab] = useState<"login" | "signup">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const user =
        tab === "login"
          ? await login(email.trim(), password)
          : await signup(email.trim(), password, name.trim(), invite.trim());
      onAuthed(user);
    } catch (err) {
      if (err instanceof ApiError) {
        if (tab === "login" && err.status === 401)
          setError("wrong email or password.");
        else if (tab === "signup" && err.status === 403)
          setError("that invite code is not valid.");
        else if (tab === "signup" && err.status === 409)
          setError("an account with that email already exists.");
        else setError(err.message || "something went wrong.");
      } else {
        setError("could not reach bloop. is it online?");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden bg-bloop px-4 py-10">
      {/* hero photo + rings, same language as the landing + empty state */}
      <img
        src="/assets/hero.jpg"
        alt=""
        aria-hidden="true"
        className="absolute inset-0 h-full w-full object-cover opacity-40"
      />
      <div className="absolute inset-0 bg-bloop/50" aria-hidden="true" />
      <svg
        className="pointer-events-none absolute -left-28 -top-28 h-96 w-96 text-white/20"
        viewBox="0 0 200 200"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="100" cy="100" r="45" stroke="currentColor" />
        <circle cx="100" cy="100" r="75" stroke="currentColor" />
        <circle cx="100" cy="100" r="100" stroke="currentColor" />
      </svg>
      <svg
        className="pointer-events-none absolute -bottom-32 -right-24 h-96 w-96 text-white/20"
        viewBox="0 0 200 200"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="100" cy="100" r="45" stroke="currentColor" />
        <circle cx="100" cy="100" r="75" stroke="currentColor" />
        <circle cx="100" cy="100" r="100" stroke="currentColor" />
      </svg>

      <div className="relative w-full max-w-sm">
        <div className="motion-safe:rise mb-6 flex flex-col items-center">
          <BlobIcon className="h-14 w-14" />
          <h1 className="sticker font-wordmark text-7xl font-extrabold leading-[0.9] text-bloop">
            bloop
          </h1>
          <p className="mt-2 text-sm font-medium text-white [text-shadow:0_1px_10px_rgb(0_0_0/0.3)]">
            tiny blob. big brain.
          </p>
        </div>

        <div className="motion-safe:rise border border-neutral-200 bg-white [animation-delay:90ms]">
          {/* tabs */}
          <div role="tablist" aria-label="sign in or sign up" className="flex border-b border-neutral-200">
            {(["login", "signup"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                type="button"
                onClick={() => {
                  setTab(t);
                  setError("");
                }}
                className={cx(
                  "flex-1 px-4 py-3 font-wordmark text-sm font-bold transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-bloop-deep",
                  tab === t
                    ? "bg-white text-bloop-deep"
                    : "bg-neutral-100 text-neutral-500 hover:text-neutral-700"
                )}
              >
                {t === "login" ? "log in" : "sign up"}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-3 px-5 py-5">
            {tab === "signup" && (
              <div>
                <label htmlFor="auth-name" className="mb-1 block text-[11px] font-semibold text-neutral-500">
                  name
                </label>
                <input
                  id="auth-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoComplete="name"
                  placeholder="blob fisher"
                  className={inputCls}
                />
              </div>
            )}
            <div>
              <label htmlFor="auth-email" className="mb-1 block text-[11px] font-semibold text-neutral-500">
                email
              </label>
              <input
                id="auth-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                placeholder="you@work.com"
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="auth-pass" className="mb-1 block text-[11px] font-semibold text-neutral-500">
                password
              </label>
              <input
                id="auth-pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                autoComplete={tab === "login" ? "current-password" : "new-password"}
                placeholder="••••••••"
                className={inputCls}
              />
            </div>
            {tab === "signup" && (
              <div>
                <label htmlFor="auth-invite" className="mb-1 block text-[11px] font-semibold text-neutral-500">
                  invite code
                </label>
                <input
                  id="auth-invite"
                  value={invite}
                  onChange={(e) => setInvite(e.target.value)}
                  required
                  placeholder="bloop-XXXX"
                  className={inputCls}
                />
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
              >
                <AlertIcon className="mt-px h-3.5 w-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-full bg-bloop px-6 py-3 font-wordmark text-base font-bold text-neutral-900 transition-[transform,background-color] duration-150 hover:bg-bloop-deep hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep motion-safe:hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy && <SpinnerIcon className="h-4 w-4" />}
              {tab === "login" ? "log in" : "create account"}
            </button>
          </form>
        </div>

        <p className="motion-safe:rise mt-4 text-center text-[11px] font-medium text-white/80 [animation-delay:150ms] [text-shadow:0_1px_8px_rgb(0_0_0/0.3)]">
          acts across your apps · proves every step
        </p>
      </div>
    </div>
  );
}
