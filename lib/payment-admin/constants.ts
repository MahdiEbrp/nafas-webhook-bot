export const PAYMENT_LIMITS = {
  providerNameMinLength: 2,
  providerNameMaxLength: 80,
  providerSearchMaxLength: 100,
  providerListPageMax: 100_000,
  providerListPerPageMax: 50,
  providerListPerPageDefault: 10,
  merchantIdMinLength: 8,
  merchantIdMaxLength: 64,
  callbackUrlMaxLength: 512,
  apiUrlMaxLength: 512,
  transactionSearchMaxLength: 100,
  transactionListPageMax: 100_000,
  transactionListPerPageMax: 50,
  transactionListPerPageDefault: 20,
  amountMin: 1_000,
  amountMax: 1_000_000_000,
  descriptionMaxLength: 500,
  pageMin: 1,
  pageDefault: 1,
  searchDebounceMs: 400,
  requestBodyLimitBytes: 128 * 1024,
  checkoutIdempotencyKeyMinLength: 16,
  checkoutIdempotencyKeyMaxLength: 128,
  checkoutExpiryMinutes: 15,
  testRateLimit: 10,
  sendRateLimit: 10,
  rateLimitWindowMs: 60_000,
  percentageBase: 100,
  skeletonRows: 3,
  // aliases for exact clone compatibility
  emptyLength: 0,
  zero: 0,
  messageMaxLength: 2000,
  messageListPerPageDefault: 20,
  campaignNameMaxLength: 120,
  providerSenderMaxLength: 32,
  providerTokenMaxLength: 4096,
  recipientListPerPageDefault: 10,
  messageListPageMax: 100_000,
} as const;

export const PAYMENT_LOCALES = { fa: "fa", en: "en" } as const;
export const PAYMENT_SEND_MODES = { custom: "custom", template: "template" } as const;

export const PAYMENT_NETWORK = {
  requestTimeoutMs: 12_000,
  maxAttempts: 3,
  retryDelayMs: 250,
} as const;

export const PAYMENT_API_ROUTES = {
  providers: "/api/v1/admin/payment/providers",
  transactions: "/api/v1/admin/payment/transactions",
  overview: "/api/v1/admin/payment/overview",
} as const;

export const PAYMENT_DASHBOARD_ROUTES = {
  root: "/dashboard/payment",
  providers: "/dashboard/payment/providers",
  addProvider: "/dashboard/payment/providers/add",
  transactions: "/dashboard/payment/transactions",
  addTransaction: "/dashboard/payment/transactions/add",
} as const;

export const PAYMENT_PERMISSIONS = {
  read: "payment.read",
  write: "payment.write",
  manage: "payment.manage",
  send: "payment.send",
} as const;

export const PAYMENT_UI = {
  selectSideOffset: 4,
  maskedMerchantPrefix: "•••• ",
} as const;

export const PAYMENT_PROVIDER_PROTOCOL = {
  zarinpal: {
    requestPath: "/pg/v4/payment/request.json",
    verifyPath: "/pg/v4/payment/verify.json",
    unverifiedPath: "/pg/v4/payment/unVerified.json",
    startPayUrl: "https://www.zarinpal.com/pg/StartPay/",
    sandboxStartPayUrl: "https://sandbox.zarinpal.com/pg/StartPay/",
  },
} as const;

export const PAYMENT_ERROR_MESSAGES = {
  providerCreateFailed: "Could not create payment provider.",
  providerNotFound: "Payment provider not found.",
  providerNotConfigured: "No active payment provider is configured.",
  transactionCreateFailed: "Could not create payment transaction.",
  transactionNotFound: "Payment transaction not found.",
  invalidAmount: "Invalid payment amount.",
  verifyFailed: "Payment verification failed.",
  providerCheckFailed: "Could not complete provider check.",
  unsafeProviderUrl: "Provider URL must use HTTPS.",
} as const;

export const PAYMENT_ERROR_CODES = {
  providerNotFound: "PAYMENT_PROVIDER_NOT_FOUND",
  providerNotConfigured: "PAYMENT_PROVIDER_NOT_CONFIGURED",
  transactionNotFound: "PAYMENT_TRANSACTION_NOT_FOUND",
  invalidAmount: "INVALID_PAYMENT_AMOUNT",
  verifyFailed: "PAYMENT_VERIFY_FAILED",
  // eslint-disable-next-line no-secrets/no-secrets -- error code constant, not a credential
  providerCheckFailed: "PAYMENT_PROVIDER_CHECK_FAILED",
  unsafeProviderUrl: "UNSAFE_PROVIDER_URL",
  providerHttpError: "PROVIDER_HTTP_ERROR",
  providerTimeout: "PROVIDER_TIMEOUT",
} as const;

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: "pending",
  requested: "requested",
  verified: "verified",
  failed: "failed",
  refunded: "refunded",
  cancelled: "cancelled",
};
