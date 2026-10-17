/**
 * What counts as spending, by the row's own text and not just its category.
 *
 * The categoriser files most card payoffs as `payment`, which spend totals
 * already skip, but not all of them: "ELECTRONIC WITHDRAWAL AMEX EPAYMENT"
 * reads as a cash withdrawal, and "CAPITAL ONE" or "DISCOVER" alone on a
 * checking account match no rule at all. Each of those is the settlement of
 * card purchases that are already counted on the card, so counting the
 * payoff too double-counts the month. Brokerage and exchange buys are the
 * same kind of mistake: money moved into an asset the reader still owns.
 *
 * Pure; every caller that sums spending (spend-trend, the recurring detector)
 * asks here.
 */

/** Same set as `report-summary.ts`; kept here so this file imports nothing. */
const INTERNAL_CATEGORIES: ReadonlySet<string> = new Set(['transfer', 'payment']);

/** Phrases that mean "a payment onto a card or loan", on either side of it. */
const PAYOFF_PHRASES =
  /\b(e-?payment|epay|autopay|auto ?pay|payment thank you|thank you for your payment|online payment|mobile payment|payment received|card payment|crd pmt|cr crd|crd ?autopay|credit crd|ccpymt|cc pymt|pymt|bill ?pay(ment)?)\b/i;

/**
 * Card issuers. A debit to one of these from a deposit account is the card
 * being paid off; on the card itself the same name is just the merchant field
 * of a purchase (Amex Travel), so this only applies to deposit accounts.
 */
const CARD_ISSUERS =
  /\b(amex|american express|capital one|capitalone|discover|chase (cr|card|credit|epay)|citi ?card|citibank card|barclay ?card|barclays|synchrony|syncb|apple card|gs bank|goldman sachs bank|credit one|bk of amer|bank of america (card|credit)|wells fargo card|us bank card|card ?services|cardmember serv)\b/i;

/** Loan servicers: debt service, never a cut and never spending. */
const LOAN_PAYEES =
  /\b(mortgage|auto ?loan|car loan|student loan|loan pmt|loan payment|navient|nelnet|mohela|great lakes|sallie mae|ally (auto|financial)|toyota financial|honda financial|chrysler capital|santander consumer|westlake|carmax auto|lightstream|sofi loan|upstart|lending ?club|prosper)\b/i;

/** Brokerages, robo-advisers and exchanges: buying an asset, not spending. */
const INVESTMENT_PAYEES =
  /\b(robinhood|webull|vanguard|fidelity|schwab|e\*?trade|etrade|betterment|wealthfront|acorns|stash ?invest|m1 finance|sofi invest|tastytrade|tastyworks|interactive brokers|ibkr|public\.com|coinbase|kraken|gemini|binance|brokerage|treasurydirect)\b/i;

/**
 * Fees and interest worth calling out, by kind, most specific first. A bare
 * "RETURNED PAYMENT" on a card is the payment being undone, not a fee, so the
 * returned-payment kind needs "fee" (or NSF, which is always one).
 */
const FEE_RULES: Array<{ kind: FeeKind; test: (t: string) => boolean }> = [
  {
    kind: 'returned_payment',
    test: (t) => /\b(nsf|insufficient funds)\b/i.test(t) || (/\breturn(ed)? (payment|item|check|ach|pmt)\b/i.test(t) && /\b(fee|charge)\b/i.test(t)),
  },
  { kind: 'overdraft', test: (t) => /\b(overdraft|od fee|overdrawn)\b/i.test(t) },
  { kind: 'late', test: (t) => /\blate (fee|charge|payment fee)\b/i.test(t) },
  { kind: 'interest', test: (t) => /\b(interest charge|purchase interest|interest on purchases|cash advance interest|finance charge|interest charged)\b/i.test(t) },
  { kind: 'fee', test: (t) => /\b(annual (fee|membership)|service charge|fee)\b/i.test(t) },
];

export type FeeKind = 'returned_payment' | 'overdraft' | 'late' | 'interest' | 'fee';

export interface RuleTransaction {
  amount: number;
  category?: string | null;
  payee?: string | null;
  description?: string | null;
}

export interface RuleAccount {
  is_liability: boolean;
  effective_kind?: string;
}

function text(tx: RuleTransaction): string {
  return `${tx.payee ?? ''} ${tx.description ?? ''}`.replace(/\s+/g, ' ').trim();
}

/** A payment onto a card: the debit leaving checking, or the credit landing on the card. */
export function isCardPayoff(tx: RuleTransaction, account: RuleAccount): boolean {
  const t = text(tx);
  if (!t) return false;
  if (account.is_liability) return tx.amount > 0 && PAYOFF_PHRASES.test(t);
  if (tx.amount >= 0) return false;
  return PAYOFF_PHRASES.test(t) || CARD_ISSUERS.test(t);
}

/** A loan instalment leaving a deposit account (or landing on the loan). */
export function isLoanPayment(tx: RuleTransaction): boolean {
  return LOAN_PAYEES.test(text(tx));
}

/** Money moved into a brokerage or exchange from a deposit account. */
export function isInvestmentBuy(tx: RuleTransaction, account: RuleAccount): boolean {
  if (account.effective_kind === 'investment') return true;
  return !account.is_liability && tx.amount < 0 && INVESTMENT_PAYEES.test(text(tx));
}

/** The fee or interest kind of a debit, or null. Only debits are fees; a fee reversal is a credit. */
export function feeKind(tx: RuleTransaction): FeeKind | null {
  if (!(tx.amount < 0)) return null;
  const t = text(tx);
  if (!t) return null;
  for (const rule of FEE_RULES) if (rule.test(t)) return rule.kind;
  return tx.category === 'fees' ? 'fee' : null;
}

/**
 * How much a row adds to spending, stated positive (a card refund is
 * negative). Zero for transfers, card payoffs, loan payments, investment
 * buys and income. Fees and interest ARE spending: they are money gone.
 */
export function spendDelta(tx: RuleTransaction, account: RuleAccount): number {
  const amount = Number(tx.amount);
  if (!Number.isFinite(amount) || amount === 0) return 0;
  if (account.effective_kind === 'investment') return 0;
  if (feeKind(tx)) return -amount;
  if (INTERNAL_CATEGORIES.has(String(tx.category ?? ''))) return 0;
  if (tx.category === 'income') return 0;
  if (isCardPayoff(tx, account) || isLoanPayment(tx) || isInvestmentBuy(tx, account)) return 0;
  // A debit is spending; a credit on a card is a refund that undoes some.
  // A credit on a deposit account is income and is not part of spending.
  if (amount < 0) return -amount;
  return account.is_liability ? -amount : 0;
}
