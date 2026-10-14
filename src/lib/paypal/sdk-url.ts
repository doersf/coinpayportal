/**
 * The PayPal JS SDK script URL and attributes for one checkout.
 *
 * Self-serve: the merchant's own client id. Partner: the platform's client id
 * plus `merchant-id` (the seller) and the BN code as data-partner-attribution-id,
 * which is how PayPal attributes the order to the platform.
 */
export interface PaypalSdkOptions {
  clientId: string;
  currency: string;
  merchantId?: string | null;
  partnerAttributionId?: string | null;
}

export function paypalSdkUrl(options: PaypalSdkOptions): string {
  const params = new URLSearchParams({
    'client-id': options.clientId,
    currency: options.currency.toUpperCase(),
    intent: 'capture',
    components: 'buttons',
  });
  if (options.merchantId) params.set('merchant-id', options.merchantId);
  // The SDK serves sandbox and live from the same host; the client id decides.
  return `https://www.paypal.com/sdk/js?${params.toString()}`;
}

export function paypalSdkAttributes(options: PaypalSdkOptions): Record<string, string> {
  return options.partnerAttributionId
    ? { 'data-partner-attribution-id': options.partnerAttributionId }
    : {};
}
