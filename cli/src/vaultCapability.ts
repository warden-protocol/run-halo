import type { FacilitatorVaultStatus } from "./vault-address";

export const VAULT_IDENTITY_CACHE_TTL_MS = 5_000;
export const VAULT_IDENTITY_ANNOUNCEMENT_GRACE_MS = 60_000;

type InspectVaultIdentity = () => Promise<FacilitatorVaultStatus>;

export function retainVaultIdentityAnnouncement(
  status: FacilitatorVaultStatus,
  wasCapable: boolean,
  lastMatchAt: number | null,
  now: number,
  graceMs = VAULT_IDENTITY_ANNOUNCEMENT_GRACE_MS
): boolean {
  if (status.status === "match") return true;
  return (
    status.status === "unavailable" &&
    wasCapable &&
    lastMatchAt !== null &&
    now - lastMatchAt <= graceMs
  );
}

export class FacilitatorIdentityProbe {
  private inFlight: Promise<FacilitatorVaultStatus> | null = null;
  private cachedResult: { checkedAt: number; status: FacilitatorVaultStatus } | null = null;
  private lastMatchAtValue: number | null = null;

  constructor(
    private readonly inspect: InspectVaultIdentity,
    private readonly now: () => number = Date.now,
    private readonly cacheTtlMs = VAULT_IDENTITY_CACHE_TTL_MS
  ) {}

  get lastMatchAt(): number | null {
    return this.lastMatchAtValue;
  }

  check(forceFresh = false): Promise<FacilitatorVaultStatus> {
    const now = this.now();
    if (
      !forceFresh &&
      this.cachedResult &&
      now - this.cachedResult.checkedAt <= this.cacheTtlMs
    ) {
      return Promise.resolve(this.cachedResult.status);
    }
    if (this.inFlight) return this.inFlight;

    const check = this.inspect()
      .then((status) => {
        const checkedAt = this.now();
        this.cachedResult = { checkedAt, status };
        if (status.status === "match") {
          this.lastMatchAtValue = checkedAt;
        }
        return status;
      })
      .finally(() => {
        if (this.inFlight === check) this.inFlight = null;
      });
    this.inFlight = check;
    return check;
  }
}

export class CapabilityAnnouncementSync {
  private desired: boolean;
  private committed: boolean;
  private refreshRequested = false;
  private inFlight: Promise<void> | null = null;

  constructor(
    initial: boolean,
    private readonly publish: (capability: boolean, promotion: boolean) => Promise<void>
  ) {
    this.desired = initial;
    this.committed = initial;
  }

  get announcedCapability(): boolean {
    return this.committed;
  }

  sync(capability: boolean): Promise<void> {
    this.desired = capability;
    return this.startDrain();
  }

  refresh(): Promise<void> {
    this.refreshRequested = true;
    return this.startDrain();
  }

  private startDrain(): Promise<void> {
    if (!this.inFlight) {
      const drain = this.drain().finally(() => {
        if (this.inFlight === drain) this.inFlight = null;
      });
      this.inFlight = drain;
    }
    return this.inFlight;
  }

  private async drain(): Promise<void> {
    while (this.desired !== this.committed || this.refreshRequested) {
      const target = this.desired;
      const promotion = target && target !== this.committed;
      this.refreshRequested = false;
      await this.publish(target, promotion);
      this.committed = target;
    }
  }
}
