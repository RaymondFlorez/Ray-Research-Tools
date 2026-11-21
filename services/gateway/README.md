# services/gateway

PRD 4's model fleet, reached the way the user chose: any model, open or closed, from any
provider, each user calling on their own account. The router (`canvas-router`) decides which
model a task goes to; this is what makes the call.

```bash
cd services/gateway
go test -race ./...                       # 28 tests; two live and four on Postgres, skipped by default
GATEWAY_LIVE=1 go test ./provider/        # adds one call to api.anthropic.com with an invalid key
GATEWAY_LOCAL_MODEL_URL=http://127.0.0.1:8081/v1 GATEWAY_LOCAL_MODEL=smollm2-360m \
  go test ./server/ -run LocalModel -v    # a real open-weight model, behind any Chat Completions server

GATEWAY_VAULT_KEY=$(openssl rand -base64 32) go run ./cmd/gateway \
   -auth-url https://picasso.example.com -providers config/providers.json -users ../dataplane/config/users.json -vault vault.json \
   -public-url http://127.0.0.1:8750 -return-url http://127.0.0.1:5173/models.html \
   -audit-pg postgres://... -migrate
# or -ephemeral instead of the key and -vault, for development; without -audit-pg the trail is in memory
```

| Package | What it does |
|---|---|
| `provider` | One request and response shape; adapters for Anthropic (the official Go SDK), the Chat Completions API (OpenAI and every server that speaks it) and Gemini |
| `accounts` | Each user's credential per provider, sealed with AES-256-GCM, bound to its user |
| `server` | Providers, connecting by sign-in or API key, chat, and the audit log |
| `identity` | Verifies picasso-auth's session tokens: the same package and contract test as the data plane's |
| `audit` | PRD 7.2's trail, identical to the data plane's package. CI compares the two copies, and the data plane's job runs it on Postgres |

## Every model, three adapters

Three API families cover the field. **Anthropic** for Claude. **Chat Completions** for OpenAI's
models and for nearly everything else: OpenRouter, Together, Groq, Mistral, DeepSeek, xAI,
and the open-weight servers, vLLM (the PRD's choice), Ollama, LM Studio and llama.cpp. Each
is one provider entry with a base URL. **Gemini** for Google's. `config/providers.json` ships
six providers: OpenRouter, Anthropic, OpenAI, Gemini, and Ollama and vLLM on the gateway's
machine. A provider is a JSON entry, not code.

## Signing in

A user connects a provider in one of two ways.

- **Sign in, where the provider offers it.** OpenRouter does: an OAuth flow with PKCE that
  ends in a key on the user's own OpenRouter account. One sign-in reaches its whole catalogue
  of open and closed models. The verifier and the user it belongs to stay on the gateway,
  keyed by an unguessable state in the callback URL. The callback works once, within ten
  minutes, and the test plays the whole flow, including a replay, a cancel, a forged code
  and an expiry.
- **An API key from the user's account**, for Anthropic, OpenAI and Gemini, pasted once. A
  sign-in through any of those providers' own identity systems is not built.

Self-hosted servers (`auth: none`) need nothing and are shared.

## Rules enforced where they cannot be skipped

- **Placement decides who may see what.** Every chat names its data class, and a request with
  no class is refused, not assumed public. Positions and MNPI-risk content go only to providers
  marked `self_hosted` or `on_device`, never to a vendor's API: the routing policy's hard rule,
  applied at the last point before data leaves. The test makes the vendor reachable and
  connected, and checks that it received nothing.
- **A vendor is never reached on the operator's account.** A vendor provider with `auth: none`
  is a configuration error, since every user's calls would go out under one key with nothing
  to say whose they were.
- **A caller never chooses the upstream.** Requests name a provider id; URLs are configuration.
- **Nothing in the environment steers a call.** Given a key, Anthropic's Go SDK reads no
  credential from the environment, but it still applies `ANTHROPIC_BASE_URL` and
  `ANTHROPIC_CUSTOM_HEADERS` from the gateway's own environment. The adapter turns those
  defaults off. The test sets all three and checks none takes effect, and fails without the
  switch, with the custom header arriving at the provider.
- **A credential goes in and does not come out.** The API shows a connection's method, its
  date and the key's last four characters. The vault file holds only ciphertext, owner-only,
  and a sealed secret copied to another user's row fails to open. Provider errors are scrubbed
  of the credential.
- **Every dispatch is on the audit trail before the provider is called** (PRD 7.2).
  - A chat names its `purpose`, a task name such as `sql.generate`. A sentence is refused,
    because free text is where a prompt would end up in the trail.
  - The record is written first: actor, tenant, `provider/model`, purpose, the caller's
    `traceparent` id (returned in `X-Picasso-Trace`), and the data class sent.
  - A trail that cannot be written means no call. The test makes the trail fail, and checks
    that the provider received nothing. With that check removed, the test fails: the call goes
    out unrecorded.
  - A second record with the same trace id holds the outcome and the token counts. The call
    has happened by then, so if that write fails it is logged, and the answer is still returned.
  - Neither record holds message content.
- **Each user also sees their own calls.** `/v1/audit` lists who, which provider and model,
  what data class, the outcome and the tokens. It is append-only, holds no content, and shows
  each user only their own entries. It is a view for the user, separate from the trail.

## Measured against the real thing

**A real model, on 20 November 2026.** SmolLM2-360M-Instruct (Apache-2.0; the Q8_0 GGUF from
Hugging Face, SHA-256 `48ab3034…7750201`, as published), served on CPU by llama.cpp's
OpenAI-compatible server (llama-cpp-python 0.3.16), configured as a `self_hosted` provider
with `auth: none`. No account and no key. Through the gateway binary, with the trail on
Postgres:
- Positions-class requests went to it and came back: 20 calls, 0.88s at p50 and 1.55s at p95
  end to end on four CPU cores. Each wrote its two records, `sent: positions` before the call
  and `returned: end, 57 in, N out` after it, with no message text on the trail.
- The same request to OpenRouter, a vendor, was refused with 403 and nothing was sent.
- **It answered none of them correctly.** Asked for the unrealized profit on 1,000 shares
  bought at $120 and priced at $135, it said $35, $10, $119,000 or $875; 0 of 20 said $15,000.
  This checks the path, not the model. It is also why the numeric checks in `canvas-agents`
  exist, and why a router should not send arithmetic to a model this small.

The test above makes the same call against whatever model the two variables name, and checks
the answer arrived, the trail's two records, and that the vendor stand-in received nothing.

Anthropic's API is the other provider host this environment reaches. Measured:
- Anthropic's Go SDK v2.4.0 sends an API key as `Authorization: Bearer`, not as `x-api-key`.
  The first stand-in test assumed the latter, and the SDK is the authority on what it sends.
- `api.anthropic.com` reads a bearer token as an API key. An invalid one comes back as 401
  `authentication_error`, "invalid x-api-key", and the gateway returns that with the key
  scrubbed (`GATEWAY_LIVE=1`).

## What is not covered

- **No vendor's model has answered.** The one real model called is a 360M open-weight model on
  the gateway's own machine, through the Chat Completions adapter. There is no key for any
  vendor here: the Anthropic adapter has reached the real API only to be refused, and the
  Gemini and OpenRouter-exchange code is tested against stand-ins written to each one's
  documented API. CI's `real-model` job runs the local-model test on every push: it
  downloads the 360M weights, checks them against the published hash, and serves them with
  llama.cpp on the runner's CPU.
- **Text in, text out.** No streaming, tools, images, structured output or thinking controls.
  No sampling parameters are sent, since current Claude models reject them.
- **Identity is picasso-auth's session token**, as at the data plane, with the same
  `-dev-identity` escape for development, and the same revocation list: a logged-out session
  is refused within five seconds.
- **No revocation upstream.** Disconnecting deletes the gateway's copy; the key stays valid with
  the provider until the user revokes it there.
- **The vault key rotates by hand, with no KMS.** `-rekey` re-seals every credential from
  `GATEWAY_VAULT_KEY` to `GATEWAY_VAULT_NEW_KEY`, all or nothing. The test re-seals two, finds
  the old key opens neither, and finds that a rekey under the wrong key changes nothing on
  disk. The per-user dispatch log is in memory. The trail is in Postgres with `-audit-pg`,
  under the data plane's rules: the process writes as the role it is given, and records
  expire only when the schema's owner runs expiry, once or on a schedule, with the data
  plane binary's `-audit-expire` and `-audit-expire-every`.
- **No budgets or rate limits.** `canvas-router` holds the budget rules and does not yet call
  this gateway; nothing here stops a user spending their own account.
