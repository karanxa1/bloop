import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { ApiError, login, signup } from "../api";
import type { User } from "../types";
import { AlertIcon, BlobIcon, CheckIcon, ShieldCheckIcon, SpinnerIcon } from "../icons";
import { cx } from "../lib";

interface AuthScreenProps {
  onAuthed: (user: User) => void;
}

type Mode = "login" | "signup";
type Field = "name" | "email" | "password";

/** mirrors core/src/auth.rs */
const PASSWORD_MIN = 6;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(mode: Mode, v: Record<Field, string>): Partial<Record<Field, string>> {
  const e: Partial<Record<Field, string>> = {};
  if (mode === "signup" && !v.name.trim()) e.name = "tell bloop what to call you.";
  if (!v.email.trim()) e.email = "enter your email.";
  else if (!EMAIL_RE.test(v.email.trim())) e.email = "that doesn’t look like an email.";
  if (!v.password) e.password = "enter your password.";
  else if (mode === "signup" && v.password.length < PASSWORD_MIN)
    e.password = `use at least ${PASSWORD_MIN} characters.`;
  return e;
}

const inputBase =
  "h-11 w-full border bg-white px-3.5 text-base text-neutral-900 placeholder:text-neutral-400 transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-2 sm:text-sm";

export function AuthScreen({ onAuthed }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>("login");
  const [values, setValues] = useState<Record<Field, string>>({ name: "", email: "", password: "" });
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [serverError, setServerError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const uid = useId();

  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) emailRef.current?.focus();
  }, []);

  const errors = validate(mode, values);
  const shown = (f: Field) => (touched[f] ? errors[f] : undefined);

  const set = (f: Field) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [f]: e.target.value }));
    if (serverError) setServerError("");
  };
  const blur = (f: Field) => () => {
    if (values[f]) setTouched((t) => ({ ...t, [f]: true }));
  };

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    setServerError("");
    setTouched({});
  };

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next: Mode = mode === "login" ? "signup" : "login";
    switchMode(next);
    document.getElementById(`${uid}-tab-${next}`)?.focus();
  };

  const onCaps = (e: KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(e.getModifierState("CapsLock"));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errs = validate(mode, values);
    setTouched({ name: true, email: true, password: true });
    const first = (["name", "email", "password"] as Field[]).find((f) => errs[f]);
    if (first) {
      document.getElementById(`${uid}-${first}`)?.focus();
      return;
    }
    setServerError("");
    setBusy(true);
    try {
      const user =
        mode === "login"
          ? await login(values.email.trim(), values.password)
          : await signup(values.email.trim(), values.password, values.name.trim());
      onAuthed(user);
    } catch (err) {
      if (err instanceof ApiError) {
        if (mode === "login" && err.status === 401) setServerError("wrong email or password.");
        else if (mode === "signup" && err.status === 409)
          setServerError("an account with that email already exists — try signing in.");
        else if (err.status === 429) setServerError("too many attempts — wait a minute and try again.");
        else setServerError(err.message || "something went wrong. try again.");
      } else {
        setServerError("couldn’t reach bloop. check your connection.");
      }
      setBusy(false);
    }
  };

  const signup_ = mode === "signup";

  return (
    <div className="h-full overflow-y-auto bg-page lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      {/* ── brand hero (≥1024px) ── */}
      <aside
        aria-hidden="true"
        className="relative hidden overflow-hidden bg-bloop lg:flex lg:min-h-full lg:flex-col lg:justify-between lg:p-12"
      >
        <img
          src="/assets/hero.webp"
          width={1400}
          height={933}
          decoding="async"
          fetchPriority="high"
          alt=""
          className="absolute inset-0 h-full w-full object-cover opacity-35 mix-blend-multiply"
        />
        <div className="absolute inset-0 bg-bloop/55" />
        <Rings className="-left-28 -top-28" />
        <Rings className="-bottom-40 -right-32" />

        <div className="relative flex items-center gap-2.5">
          <BlobIcon className="h-8 w-8" />
          <span className="font-wordmark text-2xl font-bold leading-none text-neutral-900">bloop</span>
        </div>

        <div className="relative">
          <p className="sticker font-wordmark text-[9rem] font-extrabold leading-[0.8] text-bloop motion-safe:rise">
            bloop
          </p>
          <p className="mt-5 max-w-md text-2xl font-semibold leading-snug text-neutral-900">
            tiny blob. big brain. acts across your apps — and proves every step.
          </p>
          <ul className="mt-8 max-w-md space-y-2.5">
            <HeroPoint icon={<CheckIcon className="h-4 w-4" />}>plans the work, runs the tools, reports back</HeroPoint>
            <HeroPoint icon={<ShieldCheckIcon className="h-4 w-4" />}>verifies every write with a replayable receipt</HeroPoint>
            <HeroPoint icon={<BlobIcon className="h-4 w-4" />}>remembers what matters to you across chats</HeroPoint>
          </ul>
        </div>

        <p className="relative text-[12px] font-medium text-neutral-900/70">
          gmail · github · notion · slack · and any mcp server
        </p>
      </aside>

      {/* ── form ── */}
      <main className="flex min-h-full flex-col items-center justify-center px-4 py-10 sm:px-6">
        <div className="w-full max-w-sm">
          {/* compact brand (<1024px) */}
          <div className="mb-8 flex flex-col items-center lg:hidden">
            <BlobIcon className="h-12 w-12" />
            <span className="mt-1 font-wordmark text-4xl font-extrabold leading-none text-bloop-deep">
              bloop
            </span>
            <span className="mt-1.5 text-[13px] text-neutral-600">tiny blob. big brain.</span>
          </div>

          <div
            key={mode}
            className="mb-6 motion-safe:transition-opacity motion-safe:duration-200 starting:opacity-0"
          >
            <h1 className="font-wordmark text-3xl font-bold leading-tight text-neutral-900">
              {signup_ ? "create your account" : "welcome back"}
            </h1>
            <p className="mt-1 text-sm text-neutral-600">
              {signup_ ? "set up bloop in under a minute." : "sign in to pick up where you left off."}
            </p>
          </div>

          <div
            role="tablist"
            aria-label="sign in or sign up"
            onKeyDown={onTabKey}
            className="mb-5 grid grid-cols-2 gap-1 rounded-full bg-neutral-200/70 p-1"
          >
            {(["login", "signup"] as const).map((m) => (
              <button
                key={m}
                id={`${uid}-tab-${m}`}
                role="tab"
                type="button"
                aria-selected={mode === m}
                aria-controls={`${uid}-form`}
                tabIndex={mode === m ? 0 : -1}
                onClick={() => switchMode(m)}
                className={cx(
                  "h-9 rounded-full text-[13px] font-semibold transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep",
                  mode === m
                    ? "bg-white text-neutral-900 shadow-[0_1px_3px_rgb(0_0_0/0.12)]"
                    : "text-neutral-600 hover:text-neutral-900"
                )}
              >
                {m === "login" ? "sign in" : "sign up"}
              </button>
            ))}
          </div>

          <form
            id={`${uid}-form`}
            role="tabpanel"
            aria-labelledby={`${uid}-tab-${mode}`}
            onSubmit={submit}
            noValidate
            className="border border-neutral-200 border-l-4 border-l-bloop bg-white p-5 shadow-[0_1px_2px_rgb(0_0_0/0.04)] sm:p-6"
          >
            {serverError && (
              <div
                role="alert"
                className="mb-4 flex items-start gap-2 border border-red-200 border-l-2 border-l-red-600 bg-red-50 px-3 py-2 text-[13px] text-red-800"
              >
                <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{serverError}</span>
              </div>
            )}

            {/* name collapses without layout jump */}
            <div
              className={cx(
                "grid motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(.22,1,.36,1)]",
                signup_ ? "grid-rows-[1fr] opacity-100" : "invisible grid-rows-[0fr] opacity-0"
              )}
              aria-hidden={!signup_}
            >
              <div className="min-h-0 overflow-hidden">
                <FormField id={`${uid}-name`} label="name" error={signup_ ? shown("name") : undefined} className="pb-4">
                  {(p) => (
                    <input
                      {...p}
                      value={values.name}
                      onChange={set("name")}
                      onBlur={blur("name")}
                      disabled={!signup_}
                      autoComplete="name"
                      placeholder="blob fisher"
                      className={cx(inputBase, fieldTone(signup_ ? shown("name") : undefined))}
                    />
                  )}
                </FormField>
              </div>
            </div>

            <FormField id={`${uid}-email`} label="email" error={shown("email")} className="pb-4">
              {(p) => (
                <input
                  {...p}
                  ref={emailRef}
                  type="email"
                  inputMode="email"
                  value={values.email}
                  onChange={set("email")}
                  onBlur={blur("email")}
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="you@work.com"
                  className={cx(inputBase, fieldTone(shown("email")))}
                />
              )}
            </FormField>

            <FormField
              id={`${uid}-password`}
              label="password"
              error={shown("password")}
              hint={
                capsLock
                  ? "caps lock is on"
                  : signup_ && !shown("password")
                    ? `at least ${PASSWORD_MIN} characters`
                    : undefined
              }
              hintTone={capsLock ? "warn" : "muted"}
            >
              {(p) => (
                <div className="relative">
                  <input
                    {...p}
                    type={showPw ? "text" : "password"}
                    value={values.password}
                    onChange={set("password")}
                    onBlur={(e) => {
                      blur("password")();
                      if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node | null))
                        setCapsLock(false);
                    }}
                    onKeyDown={onCaps}
                    onKeyUp={onCaps}
                    autoComplete={signup_ ? "new-password" : "current-password"}
                    placeholder="••••••••"
                    className={cx(inputBase, "pr-12", fieldTone(shown("password")))}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((s) => !s)}
                    aria-label={showPw ? "hide password" : "show password"}
                    aria-pressed={showPw}
                    aria-controls={`${uid}-password`}
                    className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-neutral-500 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-800 focus-visible:outline-2 focus-visible:outline-bloop-deep"
                  >
                    {showPw ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
              )}
            </FormField>

            <button
              type="submit"
              disabled={busy}
              aria-busy={busy || undefined}
              className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-bloop px-6 font-wordmark text-base font-bold text-neutral-900 transition-[transform,background-color,color] duration-150 hover:bg-bloop-deep hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep motion-safe:hover:-translate-y-px disabled:cursor-progress disabled:opacity-70 disabled:hover:translate-y-0 disabled:hover:bg-bloop disabled:hover:text-neutral-900"
            >
              {busy && <SpinnerIcon className="h-4 w-4" />}
              {busy
                ? signup_
                  ? "creating account…"
                  : "signing in…"
                : signup_
                  ? "create account"
                  : "sign in"}
            </button>
          </form>

          <p className="mt-5 text-center text-[13px] text-neutral-600">
            {signup_ ? "already have an account? " : "new to bloop? "}
            <button
              type="button"
              onClick={() => {
                const next: Mode = signup_ ? "login" : "signup";
                switchMode(next);
                document.getElementById(`${uid}-tab-${next}`)?.focus();
              }}
              className="rounded-full font-semibold text-bloop-deep underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bloop-deep"
            >
              {signup_ ? "sign in" : "create an account"}
            </button>
          </p>
        </div>
      </main>
    </div>
  );
}

function fieldTone(error: string | undefined) {
  return error
    ? "border-red-500 focus:border-red-600 focus:ring-red-500/25"
    : "border-neutral-300 hover:border-neutral-400 focus:border-bloop-deep focus:ring-bloop/40";
}

interface FieldProps {
  id: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}

function FormField({
  id,
  label,
  error,
  hint,
  hintTone = "muted",
  className,
  children
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  hintTone?: "muted" | "warn";
  className?: string;
  children: (p: FieldProps) => ReactNode;
}) {
  const msgId = `${id}-msg`;
  const msg = error ?? hint;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-[12px] font-semibold text-neutral-700">
        {label}
      </label>
      {children({
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": msg ? msgId : undefined
      })}
      <p
        id={msgId}
        aria-live="polite"
        className={cx(
          "min-h-0 text-xs",
          msg && "mt-1.5",
          error ? "text-red-700" : hintTone === "warn" ? "font-medium text-amber-700" : "text-neutral-500"
        )}
      >
        {msg}
      </p>
    </div>
  );
}

function HeroPoint({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3 border-l-4 border-l-bloop-deep bg-white/85 px-4 py-3 text-[15px] font-medium text-neutral-900 backdrop-blur-sm">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bloop-deep text-white">
        {icon}
      </span>
      {children}
    </li>
  );
}

function Rings({ className }: { className: string }) {
  return (
    <svg
      className={cx("pointer-events-none absolute h-[28rem] w-[28rem] text-white/25", className)}
      viewBox="0 0 200 200"
      fill="none"
    >
      <circle cx="100" cy="100" r="45" stroke="currentColor" />
      <circle cx="100" cy="100" r="75" stroke="currentColor" />
      <circle cx="100" cy="100" r="100" stroke="currentColor" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function EyeOffIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4.2M6.6 6.6A17.4 17.4 0 002 12s3.5 7 10 7a9.7 9.7 0 005.4-1.6" />
      <path d="M9.9 9.9a3 3 0 004.2 4.2" />
    </svg>
  );
}
