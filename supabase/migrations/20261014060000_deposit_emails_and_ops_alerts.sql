-- Deposit emails to merchants + throttled operator alerts.
--
-- 1. One merchant email per payment and event. The deposit-notification sweep
--    (cron/monitor-payments/email-monitor.ts) inserts the email_queue row
--    before sending, and this index is what makes that insert the claim when
--    the HTTP cron and the in-process monitor race.
CREATE UNIQUE INDEX IF NOT EXISTS email_queue_payment_event_unique
  ON public.email_queue (payment_id, event_type)
  WHERE payment_id IS NOT NULL;

-- 2. Throttle state for operator alerts (lib/ops/alerts.ts): an empty gas
--    relayer fails every sweep every cycle, and one email about it is enough.
CREATE TABLE IF NOT EXISTS public.ops_alerts (
  key TEXT PRIMARY KEY,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.ops_alerts ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (cron, monitor) reads or writes it.
