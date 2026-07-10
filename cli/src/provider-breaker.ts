/**
 * Upstream provider circuit breaker (issue #459).
 *
 * A credit-exhaustion or auth failure from an upstream provider does NOT clear
 * on the next request — the account is out of credits or the key is bad. Rather
 * than pay the latency of forwarding a fresh failure to every consumer (and
 * keep advertising models we can't actually serve), `serve` OPENs a breaker for
 * that provider on the first such error. While open, its models are
 * de-announced from the relay, further requests are instant-rejected before the
 * consumer is charged, and a background probe re-CLOSEs the breaker once the
 * account is healthy again.
 *
 * This module is the pure state machine: which providers are open and why. The
 * fetch-based health probe, the de-announce model filtering, and the relay
 * re-announce all live in `serve.ts` (they need config + network).
 */
import type { UpstreamProviderErrorCode } from "./upstream-error";

// The subset of upstream error codes that are "sticky" — persistent faults that
// won't clear on the next request and so warrant de-announcing. A transient
// provider error (a 429 without a credit signal, a 5xx) clears on its own and is
// left to relay rotation, so it never trips the breaker.
export type StickyUpstreamCode = "credit_exhausted" | "operator_auth_failure";

export interface OpenBreaker {
  code: StickyUpstreamCode;
  since: number;
}

// Keyed by provider slug.
const openBreakers = new Map<string, OpenBreaker>();

// Notified on every trip/clear so the live relay connection can re-announce with
// the current (breaker-filtered) model set. Null while offline.
let onChange: (() => void) | null = null;

export function isStickyUpstreamCode(
  code: UpstreamProviderErrorCode | null | undefined
): code is StickyUpstreamCode {
  return code === "credit_exhausted" || code === "operator_auth_failure";
}

/** Register (or clear, with null) the re-announce hook fired on trip/clear. */
export function setBreakerChangeHandler(fn: (() => void) | null): void {
  onChange = fn;
}

export function isBreakerOpen(slug: string): boolean {
  return openBreakers.has(slug);
}

export function breakerCode(slug: string): StickyUpstreamCode | null {
  return openBreakers.get(slug)?.code ?? null;
}

export function openBreakerSlugs(): string[] {
  return [...openBreakers.keys()];
}

/**
 * Open the breaker for `slug`. No-ops (returns false) for non-sticky codes and
 * for an already-open breaker — the first fault's reason/time is kept and the
 * re-announce hook fires only on the transition, not on every repeat error.
 * Returns true iff this call newly opened the breaker.
 */
export function tripBreaker(
  slug: string,
  code: UpstreamProviderErrorCode | null | undefined,
  now: number = Date.now()
): boolean {
  if (!isStickyUpstreamCode(code)) return false;
  if (openBreakers.has(slug)) return false;
  openBreakers.set(slug, { code, since: now });
  onChange?.();
  return true;
}

/** Close the breaker for `slug`. Returns true iff it was open. */
export function clearBreaker(slug: string): boolean {
  if (!openBreakers.delete(slug)) return false;
  onChange?.();
  return true;
}

/** Test-only: drop all breaker state and the change handler. */
export function _resetBreakersForTest(): void {
  openBreakers.clear();
  onChange = null;
}
