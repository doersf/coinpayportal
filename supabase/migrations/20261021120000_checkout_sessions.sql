-- Hosted checkout sessions: one URL a site redirects a buyer to, where the
-- buyer picks any coin the business can receive (or PayPal). Every session
-- carries who is paying (customer_email, account_id) and for which property,
-- and those travel onto the underlying payment's metadata and its webhooks.
--
-- Service-role only: the public page reads it through /api/checkout/sessions.

CREATE TABLE IF NOT EXISTS public.checkout_sessions (
  id text PRIMARY KEY CHECK (id ~ '^cs_[A-Za-z0-9]{16,64}$'),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  merchant_id uuid NOT NULL,
  amount numeric(18, 2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  description text CHECK (description IS NULL OR length(description) <= 500),
  customer_email text NOT NULL CHECK (length(customer_email) BETWEEN 3 AND 320),
  account_id text NOT NULL CHECK (length(account_id) BETWEEN 1 AND 200),
  property text NOT NULL CHECK (length(property) BETWEEN 1 AND 255),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  success_url text,
  cancel_url text,
  allowed_methods text[],
  expires_in_minutes integer NOT NULL DEFAULT 60 CHECK (expires_in_minutes BETWEEN 15 AND 120),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'expired')),
  selected_method text,
  payment_id uuid,
  paypal_transaction_id uuid,
  attempt_count integer NOT NULL DEFAULT 0,
  paid_method text,
  paid_reference text,
  paid_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_business_created
  ON public.checkout_sessions(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_account
  ON public.checkout_sessions(business_id, account_id);

ALTER TABLE public.checkout_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.checkout_sessions FROM anon, authenticated;
GRANT ALL ON public.checkout_sessions TO service_role;

NOTIFY pgrst, 'reload schema';
