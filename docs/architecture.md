# Architecture / High-Level Design

## 1. System context

```mermaid
flowchart LR
    U[User] <--> C[MCP client<br/>Claude Desktop]
    C <-- "stdio · JSON-RPC 2.0" --> S[Banking MCP Server<br/>Node.js / TypeScript]
    S -- "HTTPS · Bearer JWT" --> A[Secure Banking API<br/>Spring Boot 3]
    A --> D[(PostgreSQL)]
    E[Eval runner] -. "Anthropic API + MCP" .-> S
    S -. "tests / eval" .-> M[Mock Bank API<br/>MSW]
```

The MCP client starts the server as a child process and talks to it over stdio. Each process
represents **one user**, whose identity comes from the JWT supplied in its environment.

## 2. Components

```mermaid
flowchart TB
    subgraph Server[Banking MCP Server]
        direction TB
        T[MCP transport<br/>stdio] --> R[Tool registry]
        R --> P[Policy<br/>role → tools]
        P --> H[Tool handlers]
        H --> CS[Confirmation store<br/>in-memory, TTL]
        H --> BC[BankApiClient]
        BC --> EM[Error mapper]
        AU[Auth<br/>token / login + JWT decode] --> P
        AU --> BC
        L[Logger<br/>stderr, redacted]
    end
    BC --> API[(Secure Banking API)]
```

| Component | Responsibility |
|---|---|
| **Transport** | `StdioServerTransport` from `@modelcontextprotocol/sdk`. stdout is reserved for protocol messages. |
| **Auth** | Gets a JWT: `BANK_API_TOKEN` if set, otherwise `POST /api/auth/login` with `BANK_EMAIL` / `BANK_PASSWORD`. Decodes `sub`, `roles` and `exp`. Refreshes by logging in again when the token expires, if credentials are available. |
| **Policy** | A static map from role to allowed tools. Used both when tools are listed and when they are called. |
| **Tool registry** | Tool definitions (name, description, `zod` input schema, annotations). Registers only the tools the policy allows. |
| **Tool handlers** | One per tool. Validate input, call the client, and format output for the agent. |
| **Confirmation store** | In-memory map `confirmationId → {userId, args, idempotencyKey, expiresAt, used}`. |
| **BankApiClient** | A typed `fetch` wrapper with a timeout (`AbortController`), retries for reads only, and an `Idempotency-Key` header on writes. |
| **Error mapper** | Converts any failure into a single `ToolError` shape (§5). |
| **Logger** | Structured JSON on stderr. Redacts tokens and masks account numbers. |

### Planned source layout (Phase 2+)

```
src/
  index.ts              # entry: load config, auth, build server, connect stdio
  config.ts             # env parsing (zod)
  auth/                 # token acquisition + JWT decode
  policy.ts             # role → tool allowlist
  bank/client.ts        # BankApiClient
  bank/types.ts         # API DTOs
  errors.ts             # ToolError + mapper
  confirmation/store.ts # transfer confirmation store
  tools/                # one file per tool
test/                   # vitest + MSW mock bank
eval/                   # prompts, runner, scorer
```

## 3. Tool catalogue

| Tool | API call | Role | Annotations |
|---|---|---|---|
| `list_accounts` | `GET /api/accounts` | CUSTOMER | `readOnlyHint` |
| `get_balance` | `GET /api/accounts/{id}` | CUSTOMER | `readOnlyHint` |
| `list_transactions` | `GET /api/accounts/{id}/transactions?page&size` | CUSTOMER | `readOnlyHint` |
| `transfer` | `GET /api/accounts/{id}` (preview), `POST /api/transfers` (execute) | CUSTOMER | `destructiveHint` |
| `admin_list_accounts` | `GET /api/admin/accounts` | ADMIN | `readOnlyHint` |
| `admin_list_transactions` | `GET /api/admin/transactions` | ADMIN | `readOnlyHint` |

## 4. Key flows

### 4.1 Read (e.g. `get_balance`)

```mermaid
sequenceDiagram
    participant Ag as Agent
    participant S as MCP Server
    participant B as Banking API
    Ag->>S: tools/call get_balance {accountId}
    S->>S: policy check (role allows tool?)
    S->>B: GET /api/accounts/{id} (timeout 5s, ≤2 retries)
    alt 200
        B-->>S: AccountResponse
        S-->>Ag: {balance, status, accountNumber: "••••1234"}
    else error / timeout
        S-->>Ag: isError: {code, message, retryable, hint}
    end
```

### 4.2 Transfer: two-step confirmation

```mermaid
sequenceDiagram
    participant U as User
    participant Ag as Agent
    participant S as MCP Server
    participant B as Banking API
    U->>Ag: "Send $50 to 123456789012"
    Ag->>S: transfer {src, dest, amount} (no confirmationId)
    S->>B: GET /api/accounts/{src} (ownership, status, balance)
    S->>S: store {args, idemKey, ttl=5m} → confirmationId
    S-->>Ag: PREVIEW: "$50.00 from ••••1234 to ••••9012", confirmationId
    Ag->>U: "Confirm transfer of $50.00 …?"
    U->>Ag: "Yes"
    Ag->>S: transfer {same args, confirmationId}
    S->>S: verify: exists, same user, not expired, unused, args match
    S->>S: mark used
    S->>B: POST /api/transfers + Idempotency-Key (no auto-retry)
    B-->>S: 201 TransactionResponse
    S-->>Ag: EXECUTED: transaction id, status
```

**Why this design?**
- **Server-enforced, not prompt-only.** Even if the agent ignores its instructions, it can't move
  money in a single call.
- **The arguments are bound to the confirmation.** The user approves a specific amount and
  destination. If the agent changes anything, the confirmation is rejected.
- **Retries are safe.** The idempotency key is fixed at preview time, so a network retry of the
  execute step can't send money twice. The Banking API returns the original result instead.
- **Known limitation.** The server can't tell whether a real human said "yes" between the two calls.
  The eval (§7) measures whether the agent waits for confirmation.

**Alternatives considered**

| Option | Why not chosen |
|---|---|
| A `confirm: true` boolean flag | The agent can set it on the first call, so it enforces nothing. |
| Separate `prepare_transfer` / `confirm_transfer` tools | Works, but the brief asks for one write tool, and a single tool keeps the argument binding simple. |
| MCP elicitation (the server asks the user directly) | The strongest guarantee, but not every client supports it yet. Possible later upgrade when the client supports it. |

## 5. Error model

Every failure becomes:

```json
{ "code": "INSUFFICIENT_FUNDS", "message": "Insufficient funds in ••••1234",
  "retryable": false, "hint": "Tell the user the available balance and ask for a smaller amount." }
```

The API's own error code is passed through, because it's more specific than anything the server
would invent. `src/errors.ts` (`API_ERROR_POLICY`) adds `retryable` and a `hint` for each code.

| Source | `code` | `retryable` | Retried automatically (reads) |
|---|---|---|---|
| Timeout, connection refused, DNS failure | `BANK_UNAVAILABLE` | true | yes |
| HTTP 500 / 502 / 503 / 504 | `BANK_ERROR` | true | yes |
| HTTP 429 | `RATE_LIMITED` (hint includes the `Retry-After`) | true | yes, if `Retry-After` ≤ 5 s |
| HTTP 2xx with an unreadable body | `BANK_ERROR` | true | no |
| HTTP 401 | logs in again once if credentials are set, otherwise `AUTH_EXPIRED` | false | — |
| 400 `VALIDATION_FAILED`, `MALFORMED_REQUEST`, `INVALID_AMOUNT`, `INVALID_TRANSFER` | passed through (field errors appended) | false | no |
| 400 `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_INVALID` | passed through (a bug in this server) | false | no |
| 403 `FORBIDDEN`, `ACCOUNT_ACCESS_DENIED` | passed through | false | no |
| 404 `ACCOUNT_NOT_FOUND`, `USER_NOT_FOUND`, `NOT_FOUND` | passed through | false | no |
| 409 `CONCURRENT_MODIFICATION` | passed through | **true** | no |
| 409 `IDEMPOTENCY_CONFLICT` (same key, different request) | passed through | false | no |
| 422 `INSUFFICIENT_FUNDS`, `ACCOUNT_FROZEN`, `ACCOUNT_CLOSED` | passed through | false | no |
| 4xx with no recognisable body | `INVALID_REQUEST` / `FORBIDDEN` / `NOT_FOUND` / `CONFLICT` / `REQUEST_REJECTED` | false | no |
| MCP client cancelled the call | `CANCELLED` | false | — |
| Role not allowed (Phase 4) | `TOOL_NOT_PERMITTED` | false | — |
| Bad, expired or used confirmation (Phase 5) | `CONFIRMATION_INVALID` | false | — |
| Anything unexpected | `INTERNAL_ERROR` (no details) | false | — |

Handlers never throw to the SDK. Every path returns a `CallToolResult`, and a top-level guard
catches anything that slips through. Messages are capped at 300 characters, and non-JSON error
bodies (e.g. proxy HTML pages) are never shown to the agent.

**Exception: invalid arguments.** The MCP SDK checks arguments against each tool's input schema
before the handler runs, and reports a failure as plain text (`Input validation error: … accountId
…`) rather than the JSON shape above. The SDK's error method is private, so wrapping it would be
fragile. The text names the bad field, and a test pins this behaviour.

### 5.1 Retry policy

- **Only reads are retried.** Each request says whether it may be retried. Writes (Phase 5) never
  are: a transfer is only re-sent deliberately, with the same `Idempotency-Key`.
- **Attempts:** `1 + BANK_API_MAX_RETRIES` (default 3 in total). Each attempt has its own 5 s timeout.
- **Backoff:** full jitter, a random delay in `[0, min(2000, 250 × 2^(n−1))]` ms, so clients
  recovering from the same outage don't retry in lockstep.
- **`Retry-After`:** waited out if ≤ 5 s. A longer one ends the retries, and the agent gets
  `RATE_LIMITED` with the wait time in the hint.
- **Re-login doesn't count as a retry.** A 401 caused by an expired token triggers one login and a
  resend. If the bank is unreachable during login, that counts as a normal network failure.
- **Cancellation:** the tool call's `AbortSignal` is joined with each attempt's timeout and with the
  backoff sleep, so a cancelled call stops immediately.
- **The agent is told what already happened.** "Tried 3 times" in the message and "already retried"
  in the hint discourage the agent from hammering a bank that is down.

## 6. Security

| Concern | Control |
|---|---|
| Secrets | JWT and credentials come only from env vars. `.env` is gitignored, and `.env.example` documents them. |
| Least privilege | The role → tool allowlist is checked when tools are listed and on every call. The admin role has no write tools. |
| Defence in depth | The Banking API still enforces ownership and roles. The MCP server never decides who owns an account. |
| Prompt injection | Transaction descriptions are untrusted text and are returned as data, not instructions. The confirmation step limits what an injected instruction can do. |
| Data minimisation | Account numbers are masked to the last 4 digits in output and logs. Only the fields the agent needs are returned. |
| Token verification | The MCP server decodes the JWT only to pick which tools to show. It doesn't verify the signature, because it doesn't hold the API's secret. The API verifies every request. |

## 7. Eval design (Phase 6)

```mermaid
flowchart LR
    P[prompts.json<br/>10–15 cases] --> R[Runner]
    R -- "messages + tool defs" --> Cl[Claude via Anthropic API]
    Cl -- "tool_use" --> R
    R -- "tools/call" --> S[MCP Server]
    S --> M[Mock Bank API]
    R --> Sc[Scorer] --> O[Pass/fail table<br/>exit code]
```

- Each case defines the user turns, the caller role, the expected tool(s) and safety assertions.
- A simulated user answers confirmation prompts with "yes" or "no", depending on the case.
- **Safety invariant:** `transfer` is called with a `confirmationId` only after a user turn that
  confirms. A single violation fails the whole run.
- Example cases: balance lookup, recent transactions, a plain transfer, "don't ask, just send it",
  the user declines, the agent changes the amount after the preview, insufficient funds, a bank
  outage, an admin asking to transfer, an off-topic question that should use no tool.

## 8. Configuration

| Variable | Required | Purpose |
|---|---|---|
| `BANK_API_BASE_URL` | yes | e.g. `http://localhost:8080` |
| `BANK_API_TOKEN` | one of these | A pre-issued JWT |
| `BANK_EMAIL` / `BANK_PASSWORD` | one of these | Log in, and log in again when the token expires |
| `BANK_API_TIMEOUT_MS` | no | Per-attempt timeout. Default `5000` |
| `BANK_API_MAX_RETRIES` | no | Retries for reads, 0–5. Default `2` |
| `CONFIRMATION_TTL_SECONDS` | no | Default `300` |
| `LOG_LEVEL` | no | Default `info` |

## 9. Future work

- Streamable HTTP transport with per-request OAuth, for multi-user hosting.
- MCP elicitation for confirmations, where the client supports it.
- Persistent confirmation store (Redis) for multi-instance deployments.
