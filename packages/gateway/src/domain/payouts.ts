import type { AdapterPayout } from "@opentill/adapter";
import type { Payout } from "@opentill/shared";
import type { ServiceContext } from "./invoices";

/**
 * Fold one adapter payout snapshot into the database. Idempotent: replaying a
 * snapshot that changes nothing writes nothing and publishes nothing.
 *
 * Must be called inside a transaction (initiation route / PayoutPoller.tick) —
 * the bus is synchronous, so the webhook row enqueued by the subscriber
 * commits together with the payout row.
 *
 * Returns the stored payout, or null when the snapshot was a no-op.
 */
export function applyAdapterPayout(
  ctx: ServiceContext,
  snapshot: AdapterPayout,
  now: number = Date.now(),
): Payout | null {
  const existing = ctx.repo.getPayoutByAdapterId(snapshot.payoutId);

  if (!existing) {
    const inserted = ctx.repo.insertPayout(
      {
        payoutId: snapshot.payoutId,
        kind: snapshot.kind,
        toAddress: snapshot.toAddress,
        amountSats: snapshot.amountSats,
        status: snapshot.status,
        timelockBlocksRemaining: snapshot.timelockBlocksRemaining ?? null,
        txId: snapshot.txId ?? null,
        error: snapshot.error ?? null,
      },
      now,
    );
    ctx.payoutEvents.publish({ payout: inserted, from: null, to: inserted.status, at: now });
    return inserted;
  }

  const statusChanged = existing.status !== snapshot.status;
  const fieldsChanged =
    statusChanged ||
    existing.timelockBlocksRemaining !== (snapshot.timelockBlocksRemaining ?? null) ||
    existing.txId !== (snapshot.txId ?? null) ||
    existing.error !== (snapshot.error ?? null);
  if (!fieldsChanged) return null;

  ctx.repo.updatePayout(
    existing.id,
    {
      status: snapshot.status,
      timelockBlocksRemaining: snapshot.timelockBlocksRemaining ?? null,
      txId: snapshot.txId ?? null,
      error: snapshot.error ?? null,
      ...(statusChanged && snapshot.status === "settled" ? { settledAt: now } : {}),
    },
    now,
  );
  const updated = ctx.repo.getPayout(existing.id);
  if (!updated) return null;

  // Webhooks fire on status changes only; timelock ticks just update the row.
  if (statusChanged) {
    ctx.payoutEvents.publish({ payout: updated, from: existing.status, to: updated.status, at: now });
  }
  return updated;
}
