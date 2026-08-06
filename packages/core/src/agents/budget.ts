/**
 * Cost accounting and enforcement.
 *
 * A fleet of agents can spend real money quickly, and the failure mode is
 * silent: a retry loop that looks like progress while it burns a budget. So
 * spend is checked BEFORE each call, not tallied after, and a run carries a
 * hard ceiling that cannot be exceeded by any path.
 *
 * Prices are estimates and deliberately overridable. They change, and a stale
 * hardcoded table that silently under-reports is worse than one a caller can
 * correct.
 */

export interface ModelPricing {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

/**
 * Published list prices as of 2026-08. Treat as an estimate: cache reads and
 * writes are priced differently, and any org may have negotiated rates.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

/** Used when a model is not in the table, so an unknown model never reads as free. */
export const UNKNOWN_MODEL_PRICING: ModelPricing = { inputPerMTok: 5, outputPerMTok: 25 };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function estimateUsd(
  model: string,
  usage: Usage,
  pricing: Record<string, ModelPricing> = DEFAULT_PRICING,
): number {
  const price = pricing[model] ?? UNKNOWN_MODEL_PRICING;
  // Cache reads are roughly a tenth of input; cache writes roughly 1.25x. Both
  // are approximations, which is why the result is called an estimate.
  const input = usage.inputTokens + (usage.cacheReadTokens ?? 0) * 0.1 + (usage.cacheWriteTokens ?? 0) * 1.25;
  return (input / 1e6) * price.inputPerMTok + (usage.outputTokens / 1e6) * price.outputPerMTok;
}

export interface BudgetLimits {
  /** Hard ceiling for the whole run. */
  maxUsd?: number;
  /** Per-fleet ceilings, keyed by fleet key. */
  perFleetUsd?: Record<string, number>;
  /** Ceiling for any single agent invocation, retries included. */
  maxUsdPerAgent?: number;
}

export interface BudgetCheck {
  allowed: boolean;
  reason: string;
  remainingUsd: number;
}

/**
 * Tracks spend for one run. Deliberately a plain object with no I/O: budget
 * decisions must be testable without a model, a network, or a clock.
 */
export class Budget {
  readonly limits: BudgetLimits;
  private totalUsd = 0;
  private byFleet = new Map<string, number>();
  private byAgent = new Map<string, number>();

  constructor(limits: BudgetLimits = {}) {
    this.limits = limits;
  }

  get spentUsd(): number {
    return this.totalUsd;
  }

  spentByFleet(fleet: string): number {
    return this.byFleet.get(fleet) ?? 0;
  }

  spentByAgent(agentId: string): number {
    return this.byAgent.get(agentId) ?? 0;
  }

  get remainingUsd(): number {
    return this.limits.maxUsd == null ? Infinity : Math.max(0, this.limits.maxUsd - this.totalUsd);
  }

  /**
   * Asked before every call. `estimatedUsd` is what the next attempt might
   * cost; a run refuses when it cannot afford the attempt rather than
   * discovering it went over afterwards.
   */
  canSpend(opts: { fleet: string; agentId: string; estimatedUsd?: number }): BudgetCheck {
    const estimate = opts.estimatedUsd ?? 0;

    if (this.limits.maxUsd != null && this.totalUsd + estimate > this.limits.maxUsd) {
      return {
        allowed: false,
        remainingUsd: this.remainingUsd,
        reason: `Run budget of $${this.limits.maxUsd.toFixed(2)} would be exceeded ($${this.totalUsd.toFixed(2)} spent).`,
      };
    }

    const fleetCap = this.limits.perFleetUsd?.[opts.fleet];
    if (fleetCap != null && this.spentByFleet(opts.fleet) + estimate > fleetCap) {
      return {
        allowed: false,
        remainingUsd: this.remainingUsd,
        reason: `Fleet budget for ${opts.fleet} of $${fleetCap.toFixed(2)} would be exceeded ($${this.spentByFleet(opts.fleet).toFixed(2)} spent).`,
      };
    }

    const agentCap = this.limits.maxUsdPerAgent;
    if (agentCap != null && this.spentByAgent(opts.agentId) + estimate > agentCap) {
      return {
        allowed: false,
        remainingUsd: this.remainingUsd,
        reason: `Agent ${opts.agentId} would exceed its $${agentCap.toFixed(2)} ceiling (retries included).`,
      };
    }

    return { allowed: true, remainingUsd: this.remainingUsd, reason: "Within budget." };
  }

  /**
   * Check and debit in one synchronous step.
   *
   * `canSpend` then `record` is check-then-act, and the gap between them spans
   * an `await` - so N agents started together all pass the check against the
   * same untouched balance and collectively spend N times the ceiling. That is
   * the only reason authoring was sequential.
   *
   * Debiting the estimate here, before any await, makes concurrency safe: JS
   * runs this function to completion without interleaving. `settle` then
   * corrects the reservation to what the attempt actually cost.
   */
  reserve(opts: { fleet: string; agentId: string; estimatedUsd?: number }): BudgetCheck & {
    settle: (actualUsd: number) => void;
  } {
    const check = this.canSpend(opts);
    const noop = { ...check, settle: () => {} };
    if (!check.allowed) return noop;

    const reserved = opts.estimatedUsd ?? 0;
    this.record({ fleet: opts.fleet, agentId: opts.agentId, usd: reserved });

    let settled = false;
    return {
      ...check,
      settle: (actualUsd: number) => {
        // Settling twice would double-charge the difference.
        if (settled) return;
        settled = true;
        this.record({
          fleet: opts.fleet,
          agentId: opts.agentId,
          usd: actualUsd - reserved,
        });
      },
    };
  }

  record(opts: { fleet: string; agentId: string; usd: number }): void {
    this.totalUsd += opts.usd;
    this.byFleet.set(opts.fleet, this.spentByFleet(opts.fleet) + opts.usd);
    this.byAgent.set(opts.agentId, this.spentByAgent(opts.agentId) + opts.usd);
  }

  summary(): { totalUsd: number; byFleet: Record<string, number>; byAgent: Record<string, number> } {
    return {
      totalUsd: this.totalUsd,
      byFleet: Object.fromEntries(this.byFleet),
      byAgent: Object.fromEntries(this.byAgent),
    };
  }
}

/**
 * How to describe what a run spent.
 *
 * The Claude Code CLI reports `total_cost_usd` whether or not an API key is
 * configured. With a subscription login there is no invoice: the figure is what
 * the same tokens would have cost at API rates, and what is actually consumed is
 * the plan's usage allowance.
 *
 * Printing a bare "$2.61" in that situation states a charge that is not
 * happening, which is exactly the kind of quiet inaccuracy this product is
 * supposed to be incapable of.
 */
export function isBilledInDollars(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim());
}

export function spendLabel(usd: number, billed = isBilledInDollars()): string {
  const amount = `$${usd.toFixed(4)}`;
  return billed ? amount : `${amount} equivalent`;
}

/** One line explaining what the number means, printed once per run. */
export function spendNote(billed = isBilledInDollars()): string {
  return billed
    ? "Billed to the configured API key."
    : "No API key set, so this is charged to your Claude plan's usage, not to a card. " +
      "The figure is what the same tokens would cost at API rates.";
}
