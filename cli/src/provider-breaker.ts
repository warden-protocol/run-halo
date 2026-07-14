import type { UpstreamProviderErrorCode } from "./upstream-error";

// Only persistent credit/auth faults de-announce a provider; transient errors remain routable.
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

/** Open once for a sticky fault, preserving its first reason/time; return whether state changed. */
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

export function _resetBreakersForTest(): void {
  openBreakers.clear();
  onChange = null;
}
