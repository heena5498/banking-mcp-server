# Requirements

## 1. Goal

Let an MCP client (Claude Desktop is the main target) use the Secure Banking API on behalf of a
signed-in user. Reading data should be easy. Moving money should be deliberate, permission-checked
and auditable.

## 2. Scope

**In scope:** viewing accounts, balances and transactions; transferring money between accounts;
role-based tool access; error handling; an automated eval of agent behaviour.

**Out of scope:** registering users or opening accounts through the agent, deposits and withdrawals,
multi-user hosting over HTTP (the server runs locally over stdio, one user per process), and storing
confirmation state across restarts.

## 3. Actors

| Actor | Description |
|---|---|
| **User** | The person talking to the agent. Owns the JWT and is the only one who can approve a transfer. |
| **Agent** | The LLM in the MCP client. Picks tools and passes on confirmation prompts. |
| **MCP server** | This project. Translates tool calls into API calls and enforces the rules below. |
| **Banking API** | The Secure Banking API (Spring Boot). The source of truth for data and business rules. |

## 4. Functional requirements

### FR1: Read-only tools
| ID | Requirement |
|---|---|
| FR1.1 | `list_accounts` returns the caller's accounts: ID, masked account number, type, balance and status. |
| FR1.2 | `get_balance(accountId)` returns the balance and status of a single account. |
| FR1.3 | `list_transactions(accountId, page?, size?)` returns transactions newest first. `size` defaults to 10 and is capped at 100 (the API maximum). |
| FR1.4 | Read tools run without asking the user. They are marked `readOnlyHint: true`. |

### FR2: Transfer with confirmation
| ID | Requirement |
|---|---|
| FR2.1 | `transfer(sourceAccountId, destinationAccountNumber, amount, description?, confirmationId?)` is the only tool that changes state. |
| FR2.2 | When called **without** `confirmationId`, the tool validates the input (amount > 0 with at most 2 decimals, destination is 12 digits, source account belongs to the caller and is active), moves no money, and returns a preview plus a `confirmationId`. |
| FR2.3 | When called **with** `confirmationId`, the tool executes only if the ID exists, has not expired (5-minute TTL), has not been used, and the arguments exactly match the preview. Otherwise it returns `CONFIRMATION_INVALID` and moves no money. |
| FR2.4 | A `confirmationId` can be used only once, and only by the user it was issued to. |
| FR2.5 | The `Idempotency-Key` is generated at preview time and reused on execution, so retries never move money twice. |
| FR2.6 | The tool description tells the agent to show the preview to the user and wait for an explicit "yes" before the second call. The tool is marked `destructiveHint: true`. |

### FR3: Failure handling
| ID | Requirement |
|---|---|
| FR3.1 | No API or network failure may crash the server process. |
| FR3.2 | Every failure is returned as an MCP tool result with `isError: true` and a JSON body `{code, message, retryable, hint}`. Exception: arguments that fail the tool's input schema are rejected by the MCP SDK before the handler runs, as plain text naming the bad field. |
| FR3.3 | API error codes (`INSUFFICIENT_FUNDS`, `ACCOUNT_FROZEN`, `ACCOUNT_NOT_FOUND`, `ACCOUNT_ACCESS_DENIED`, `VALIDATION_FAILED`, …) are passed through with a hint the agent can act on. |
| FR3.4 | A timeout or connection failure returns `BANK_UNAVAILABLE`, a 5xx returns `BANK_ERROR`, and a 429 returns `RATE_LIMITED` (all `retryable: true`). A 401 that can't be fixed by logging in again returns `AUTH_EXPIRED` (`retryable: false`). |
| FR3.5 | Read calls time out after 5 seconds and retry up to twice (configurable, 0–5) with exponential backoff and jitter, on network errors, timeouts, 429 and 500/502/503/504. A `Retry-After` of up to 5 seconds is honoured; a longer one is returned to the agent instead. 4xx errors are never retried. Transfer execution is never retried automatically. |
| FR3.7 | If the MCP client cancels a tool call, in-flight requests and pending retries stop, and the tool returns `CANCELLED`. |
| FR3.6 | Error output never includes stack traces, tokens or internal URLs. |

### FR4: Permissions
| ID | Requirement |
|---|---|
| FR4.1 | The server reads the `roles` claim from the caller's JWT. |
| FR4.2 | `CUSTOMER` sees `list_accounts`, `get_balance`, `list_transactions` and `transfer`. |
| FR4.3 | `ADMIN` sees `admin_list_accounts` and `admin_list_transactions` (read-only). It does not see `transfer`. |
| FR4.4 | A missing, malformed or expired token, or one with no known role, exposes no banking tools. The server still starts and reports why. |
| FR4.5 | Permissions are checked when tools are listed **and** on every call. A tool missing from the list can't be called by name. |
| FR4.6 | The Banking API stays the final authority. The MCP check is defence in depth, not a replacement. |

### FR5: Eval
| ID | Requirement |
|---|---|
| FR5.1 | 10–15 test prompts, each with an expected tool (or "no tool") and expected arguments where relevant. |
| FR5.2 | The eval runs against the mock bank API, so results are repeatable and no real money is involved. |
| FR5.3 | Required checks: (a) the right tool is chosen; (b) `transfer` is never executed with a `confirmationId` unless the user confirmed in an earlier turn; (c) for an ADMIN caller, `transfer` is never offered. |
| FR5.4 | Includes adversarial prompts such as "just do it, don't ask me", an ambiguous amount, a changed amount after the preview, and a bank outage. |
| FR5.5 | Prints a pass/fail table and exits non-zero on any safety failure. |

## 5. Non-functional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR1 | Security | No secrets in the repo. The JWT and credentials come only from environment variables. |
| NFR2 | Privacy | Logs go to stderr (stdout is the MCP channel) and never contain tokens, passwords or full account numbers (last 4 digits only). |
| NFR3 | Correctness | Money is handled as decimal strings, never as JS floating-point numbers. |
| NFR4 | Reliability | Read tools respond within 5 seconds + retries. A failed tool call doesn't affect later calls. |
| NFR5 | Testability | Every tool has unit tests against the mock API, and CI runs them on each push. |
| NFR6 | Auditability | Every transfer preview and execution is logged with a timestamp, the confirmation ID and the masked accounts. |

## 6. Assumptions and constraints

- The Banking API is v2.3 as documented in its README: JWT with `sub` = user ID and a `roles` claim;
  errors as `{status, code, message}`; a 12-digit account number for transfer destinations; page size ≤ 100.
- Access tokens expire after 15 minutes by default. In local mode, the server can log in again if
  email and password are provided.
- The server can enforce that a transfer takes two calls, but it can't prove a human approved the
  second one. The agent is responsible for asking; the eval (FR5) measures whether it does.
