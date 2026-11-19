/** DTOs returned by the Secure Banking API v2.3. Money is a JSON number (Java BigDecimal). */

export type AccountType = "CHECKING" | "SAVINGS";
export type AccountStatus = "ACTIVE" | "FROZEN" | "CLOSED";
export type TransactionType = "DEPOSIT" | "WITHDRAWAL" | "TRANSFER";
export type TransactionStatus = "PENDING" | "COMPLETED" | "FAILED";

export interface AccountResponse {
  id: string;
  accountNumber: string;
  type: AccountType;
  balance: number;
  status: AccountStatus;
  createdAt: string;
}

export interface TransactionResponse {
  id: string;
  type: TransactionType;
  status: TransactionStatus;
  amount: number;
  sourceAccountNumber: string | null;
  destinationAccountNumber: string | null;
  description: string | null;
  failureReason: string | null;
  createdAt: string;
}

export interface PageResponse<T> {
  content: T[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
}

export interface AuthResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  expiresAt: string;
}

/** Error body returned by the API for every non-2xx response. */
export interface ApiErrorBody {
  timestamp?: string;
  status: number;
  error?: string;
  code: string;
  message: string;
  path?: string;
  fieldErrors?: { field: string; message: string }[];
}
