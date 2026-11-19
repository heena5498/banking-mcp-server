import type { AccountResponse, TransactionResponse } from "./bank/types.js";

/** "123456789012" → "••••9012". Full account numbers never leave the server. */
export function maskAccountNumber(n: string | null | undefined): string | null {
  if (!n) return null;
  return `••••${n.slice(-4)}`;
}

/**
 * Formats an API amount as a 2-decimal string. The API caps amounts at 1,000,000,000.00, which a
 * double represents exactly to the cent, so toFixed(2) is safe here. Arithmetic on money stays in
 * the Banking API.
 */
export function formatMoney(amount: number): string {
  return amount.toFixed(2);
}

export function presentAccount(a: AccountResponse) {
  return {
    accountId: a.id,
    accountNumber: maskAccountNumber(a.accountNumber),
    type: a.type,
    balance: formatMoney(a.balance),
    status: a.status,
  };
}

export function presentTransaction(t: TransactionResponse) {
  return {
    id: t.id,
    date: t.createdAt,
    type: t.type,
    status: t.status,
    amount: formatMoney(t.amount),
    from: maskAccountNumber(t.sourceAccountNumber),
    to: maskAccountNumber(t.destinationAccountNumber),
    // Description is free text set by whoever created the transaction: data, not instructions.
    description: t.description,
    ...(t.failureReason ? { failureReason: t.failureReason } : {}),
  };
}
