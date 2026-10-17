-- Contractors and pay runs: hire, contract, collect tax forms, approve work and
-- pay a whole team in crypto in one run (Deel's contractor product, on CoinPay rails).
--
-- Money is USD on the books and converted at send time, like affiliate_payouts.
-- Every payable thing is a contractor_work_items row (hours, a milestone, an
-- expense, a bonus or a fixed-fee period); a pay run claims the approved ones.

CREATE TABLE IF NOT EXISTS public.contractors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  email text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 320),
  country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  job_title text CHECK (job_title IS NULL OR length(job_title) <= 200),
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'offboarded')),
  -- The portal link is the contractor's whole credential, like clients.portal_token.
  portal_token text UNIQUE,
  portal_token_created_at timestamptz,
  payout_currency text CHECK (payout_currency IS NULL OR payout_currency ~ '^[A-Z0-9_]{2,16}$'),
  payout_wallet text CHECK (payout_wallet IS NULL OR length(payout_wallet) BETWEEN 20 AND 128),
  -- A changed wallet is the classic payroll-diversion move, so pay runs flag it.
  payout_wallet_changed_at timestamptz,
  tax_form text CHECK (tax_form IS NULL OR tax_form IN ('W9', 'W8BEN', 'W8BENE')),
  tax_status text NOT NULL DEFAULT 'missing' CHECK (tax_status IN ('missing', 'submitted', 'verified')),
  tax_legal_name text CHECK (tax_legal_name IS NULL OR length(tax_legal_name) <= 200),
  tax_business_name text CHECK (tax_business_name IS NULL OR length(tax_business_name) <= 200),
  tax_classification text CHECK (tax_classification IS NULL OR length(tax_classification) <= 64),
  tax_address text CHECK (tax_address IS NULL OR length(tax_address) <= 500),
  tax_country text CHECK (tax_country IS NULL OR tax_country ~ '^[A-Z]{2}$'),
  -- AES-256-GCM under ENCRYPTION_KEY; only the last four are ever shown.
  tax_id_encrypted text,
  tax_id_last4 text CHECK (tax_id_last4 IS NULL OR tax_id_last4 ~ '^[0-9A-Za-z]{1,4}$'),
  tax_signed_name text CHECK (tax_signed_name IS NULL OR length(tax_signed_name) <= 200),
  tax_signed_at timestamptz,
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contractors_business_email ON public.contractors(business_id, lower(email));

CREATE TABLE IF NOT EXISTS public.contractor_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  contractor_id uuid NOT NULL REFERENCES public.contractors(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  scope text CHECK (scope IS NULL OR length(scope) <= 10000),
  -- fixed: `rate` per pay period; hourly: `rate` per hour; milestone: per milestone.
  kind text NOT NULL CHECK (kind IN ('fixed', 'hourly', 'milestone')),
  rate numeric(20,2) CHECK (rate IS NULL OR rate > 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  frequency text CHECK (frequency IS NULL OR frequency IN ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  start_date date NOT NULL DEFAULT current_date,
  end_date date,
  next_pay_date date,
  notice_days integer NOT NULL DEFAULT 0 CHECK (notice_days BETWEEN 0 AND 365),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'active', 'ended')),
  business_signed_name text,
  business_signed_at timestamptz,
  contractor_signed_name text,
  contractor_signed_at timestamptz,
  ended_at timestamptz,
  end_reason text CHECK (end_reason IS NULL OR length(end_reason) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'fixed' OR (rate IS NOT NULL AND frequency IS NOT NULL)),
  CHECK (kind <> 'hourly' OR rate IS NOT NULL),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_contractor_contracts_contractor ON public.contractor_contracts(contractor_id);
CREATE INDEX IF NOT EXISTS idx_contractor_contracts_fixed_due ON public.contractor_contracts(business_id, next_pay_date)
  WHERE kind = 'fixed' AND status IN ('active', 'ended') AND next_pay_date IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.contractor_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL REFERENCES public.contractor_contracts(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  due_date date,
  position integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'approved', 'paid')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contractor_milestones_contract ON public.contractor_milestones(contract_id, position);

CREATE TABLE IF NOT EXISTS public.pay_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  number integer NOT NULL,
  pay_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'processing', 'paid', 'partially_paid')),
  total numeric(20,2) NOT NULL DEFAULT 0,
  -- Drafted by the scheduler rather than a person.
  auto_drafted boolean NOT NULL DEFAULT false,
  created_by uuid,
  paid_by uuid,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, number)
);

CREATE TABLE IF NOT EXISTS public.pay_run_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pay_run_id uuid NOT NULL REFERENCES public.pay_runs(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  contractor_id uuid NOT NULL REFERENCES public.contractors(id) ON DELETE RESTRICT,
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  -- Snapshotted when the payment is sent, not when the run is drafted.
  payout_currency text,
  payout_wallet text,
  method text CHECK (method IS NULL OR method IN ('wallet', 'manual')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'paid', 'failed', 'indeterminate')),
  affiliate_payout_id uuid,
  tx_hash text,
  error text,
  invoice_number text NOT NULL,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pay_run_id, contractor_id)
);
CREATE INDEX IF NOT EXISTS idx_pay_run_items_contractor ON public.pay_run_items(contractor_id, paid_at);

CREATE TABLE IF NOT EXISTS public.contractor_work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  contractor_id uuid NOT NULL REFERENCES public.contractors(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL REFERENCES public.contractor_contracts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('hours', 'milestone', 'expense', 'bonus', 'fixed')),
  milestone_id uuid REFERENCES public.contractor_milestones(id) ON DELETE CASCADE,
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  work_date date NOT NULL DEFAULT current_date,
  minutes integer CHECK (minutes IS NULL OR minutes BETWEEN 1 AND 100000),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  receipt_url text CHECK (receipt_url IS NULL OR (receipt_url ~ '^https://' AND length(receipt_url) <= 1000)),
  submitted_by text NOT NULL CHECK (submitted_by IN ('contractor', 'business', 'schedule')),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected', 'paid')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text CHECK (review_note IS NULL OR length(review_note) <= 1000),
  -- Set when a pay run claims it. Deleting a draft run frees it again.
  pay_run_item_id uuid REFERENCES public.pay_run_items(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'hours' OR minutes IS NOT NULL),
  CHECK (kind <> 'milestone' OR milestone_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_contractor_work_items_contractor ON public.contractor_work_items(contractor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contractor_work_items_payable ON public.contractor_work_items(business_id)
  WHERE status = 'approved' AND pay_run_item_id IS NULL;
-- One fixed-fee line per contract per pay date, so a re-run of the generator is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contractor_work_items_fixed_once ON public.contractor_work_items(contract_id, work_date)
  WHERE kind = 'fixed';
-- A milestone is claimed by one live submission at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contractor_work_items_milestone_once ON public.contractor_work_items(milestone_id)
  WHERE kind = 'milestone' AND status <> 'rejected';

-- ── Pay calendar ──────────────────────────────────────────────

-- The pay date after `d` for a frequency. Semimonthly pays on the 15th and the last day.
CREATE OR REPLACE FUNCTION public.contractor_next_pay_date(d date, frequency text)
RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE frequency
    WHEN 'weekly' THEN d + 7
    WHEN 'biweekly' THEN d + 14
    WHEN 'monthly' THEN (d + interval '1 month')::date
    WHEN 'semimonthly' THEN
      CASE
        WHEN extract(day FROM d) < 15 THEN (date_trunc('month', d) + interval '14 days')::date
        WHEN d < (date_trunc('month', d) + interval '1 month - 1 day')::date
          THEN (date_trunc('month', d) + interval '1 month - 1 day')::date
        ELSE (date_trunc('month', d) + interval '1 month 14 days')::date
      END
  END
$$;

-- Turn every fixed-fee pay date up to `p_through` into an approved work item and
-- advance the contract. Idempotent per (contract, date). Returns the lines added.
CREATE OR REPLACE FUNCTION public.contractor_generate_fixed_items(p_business uuid, p_through date)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  c record;
  d date;
  added integer := 0;
  guard integer;
BEGIN
  FOR c IN
    SELECT * FROM public.contractor_contracts
    WHERE business_id = p_business AND kind = 'fixed' AND status IN ('active', 'ended')
      AND next_pay_date IS NOT NULL AND next_pay_date <= p_through
    FOR UPDATE
  LOOP
    d := c.next_pay_date;
    guard := 0;
    WHILE d <= p_through AND (c.end_date IS NULL OR d <= c.end_date) AND guard < 60 LOOP
      INSERT INTO public.contractor_work_items
        (business_id, contractor_id, contract_id, kind, description, work_date, amount, submitted_by, status, reviewed_at)
      VALUES
        (c.business_id, c.contractor_id, c.id, 'fixed', c.title || ' (' || c.frequency || ', pay date ' || d || ')',
         d, c.rate, 'schedule', 'approved', now())
      ON CONFLICT DO NOTHING;
      IF FOUND THEN added := added + 1; END IF;
      d := public.contractor_next_pay_date(d, c.frequency);
      guard := guard + 1;
    END LOOP;
    UPDATE public.contractor_contracts
      SET next_pay_date = CASE WHEN c.end_date IS NOT NULL AND d > c.end_date THEN NULL ELSE d END,
          updated_at = now()
      WHERE id = c.id;
  END LOOP;
  RETURN added;
END
$$;

-- Draft a pay run: generate fixed fees due by the pay date, then claim every
-- approved, unclaimed line into one item per contractor. Raises nothing_to_pay
-- when there is nothing approved.
CREATE OR REPLACE FUNCTION public.contractor_build_pay_run(
  p_business uuid, p_pay_date date, p_created_by uuid, p_auto boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  run_id uuid;
  run_number integer;
  r record;
  item_id uuid;
  grand numeric(20,2) := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('contractor_pay_run:' || p_business::text));
  PERFORM public.contractor_generate_fixed_items(p_business, p_pay_date);

  IF NOT EXISTS (
    SELECT 1 FROM public.contractor_work_items
    WHERE business_id = p_business AND status = 'approved' AND pay_run_item_id IS NULL AND work_date <= p_pay_date
  ) THEN
    RAISE EXCEPTION 'nothing_to_pay';
  END IF;

  SELECT coalesce(max(number), 0) + 1 INTO run_number FROM public.pay_runs WHERE business_id = p_business;
  INSERT INTO public.pay_runs (business_id, number, pay_date, created_by, auto_drafted)
    VALUES (p_business, run_number, p_pay_date, p_created_by, p_auto)
    RETURNING id INTO run_id;

  FOR r IN
    SELECT contractor_id, sum(amount)::numeric(20,2) AS total
    FROM public.contractor_work_items
    WHERE business_id = p_business AND status = 'approved' AND pay_run_item_id IS NULL AND work_date <= p_pay_date
    GROUP BY contractor_id
  LOOP
    INSERT INTO public.pay_run_items (pay_run_id, business_id, contractor_id, amount, invoice_number)
      VALUES (run_id, p_business, r.contractor_id, r.total,
              'PR' || run_number || '-' || upper(substr(replace(r.contractor_id::text, '-', ''), 1, 6)))
      RETURNING id INTO item_id;
    UPDATE public.contractor_work_items
      SET pay_run_item_id = item_id
      WHERE business_id = p_business AND contractor_id = r.contractor_id
        AND status = 'approved' AND pay_run_item_id IS NULL AND work_date <= p_pay_date;
    grand := grand + r.total;
  END LOOP;

  UPDATE public.pay_runs SET total = grand WHERE id = run_id;
  RETURN run_id;
END
$$;

-- Mark one pay run item paid, cascade to its lines and milestones, and settle
-- the run's status. Only moves an item that is still pending or processing.
CREATE OR REPLACE FUNCTION public.contractor_settle_item(
  p_item uuid, p_tx_hash text, p_method text, p_payout_id uuid, p_paid_by uuid
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  run uuid;
  open_count integer;
  failed_count integer;
BEGIN
  UPDATE public.pay_run_items
    SET status = 'paid', tx_hash = p_tx_hash, method = p_method, affiliate_payout_id = p_payout_id,
        error = NULL, paid_at = now()
    WHERE id = p_item AND status IN ('pending', 'processing', 'failed')
    RETURNING pay_run_id INTO run;
  IF run IS NULL THEN RETURN false; END IF;

  UPDATE public.contractor_work_items SET status = 'paid' WHERE pay_run_item_id = p_item;
  UPDATE public.contractor_milestones m SET status = 'paid'
    FROM public.contractor_work_items w
    WHERE w.pay_run_item_id = p_item AND w.milestone_id = m.id;

  SELECT count(*) FILTER (WHERE status <> 'paid'), count(*) FILTER (WHERE status IN ('failed', 'indeterminate'))
    INTO open_count, failed_count
    FROM public.pay_run_items WHERE pay_run_id = run;
  UPDATE public.pay_runs
    SET status = CASE WHEN open_count = 0 THEN 'paid' ELSE 'partially_paid' END,
        paid_at = CASE WHEN open_count = 0 THEN now() ELSE paid_at END,
        paid_by = coalesce(p_paid_by, paid_by),
        updated_at = now()
    WHERE id = run;
  RETURN true;
END
$$;

ALTER TABLE public.contractors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractor_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractor_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractor_work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_run_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contractors, public.contractor_contracts, public.contractor_milestones,
  public.contractor_work_items, public.pay_runs, public.pay_run_items FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contractors, public.contractor_contracts, public.contractor_milestones,
  public.contractor_work_items, public.pay_runs, public.pay_run_items TO service_role;
REVOKE ALL ON FUNCTION public.contractor_generate_fixed_items(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.contractor_build_pay_run(uuid, date, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.contractor_settle_item(uuid, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contractor_generate_fixed_items(uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.contractor_build_pay_run(uuid, date, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.contractor_settle_item(uuid, text, text, uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
