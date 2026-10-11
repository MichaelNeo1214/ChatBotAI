# SpaceBunny

> A free, keyless-to-the-visitor AI chat: Space Bunny Alpha answers on the
> server's own key, and anyone who wants more can bring their own.

## What it does

- **Works immediately.** A visitor can open the app and chat. The default
  `SpaceBunny Free MAX` model runs on a key the deployment holds, so nobody is
  asked to sign up for an API key.
- **Bring your own key.** Save a key for OpenAI, Google, Anthropic, DeepSeek or
  Groq in Settings → API Key and those models become selectable. Keys are held
  in the browser's IndexedDB and travel only on the request that needs them.
- **Rich replies.** Markdown, tables, syntax-highlighted code with a working
  copy button, and LaTeX rendered by KaTeX.
- **Your history, on your device.** Conversations are stored in IndexedDB and
  grouped by date. Optional cloud sync via Supabase.
- **Installable.** A PWA: offline shell, maskable icons, no app store required.

---

## Quick start (local)

```bash
git clone https://github.com/MichaelNeo1214/ChatBotAI.git
cd ChatBotAI
npm install
npm run dev
```

Open <http://localhost:3000>. With no `.env` at all the server runs in **demo
mode** and streams canned replies — useful for frontend work, and clearly
labelled in the UI so it is never mistaken for a real model.

To get real answers, set one variable:

```bash
AI_API_KEY=your-key-here
```

That is the whole production configuration. See `.env.example` for the rest.

---

## Deployment (Vercel)

The canonical deployment is **Vercel**, running as a static PWA plus three
serverless functions.

1. Push the repo and import it into Vercel. No build step is required.
2. Set **one** environment variable in the project settings:

   | Variable | Value |
   | --- | --- |
   | `AI_API_KEY` | Your OpenRouter (or other gateway) key for Space Bunny Alpha |

3. Deploy. `chat.michaelap.my.id` should now serve the free tier.

There is no database to provision. The serverless handlers are stateless: the
browser keeps conversation history in IndexedDB and sends the recent turns with
each request, so nothing about a user is stored server-side.

`.vercelignore` is load-bearing, not cosmetic. `vercel.json` sets
`outputDirectory: "."`, so anything not excluded there would be uploaded and
served publicly — including `.env` and `data/chatbot.db`. Keep it in sync when
you add files.

### If you deploy somewhere else

`src/` is a complete Express server with SQLite persistence, email/password
accounts and server-side sessions. Run it with `npm start`. It serves the same
frontend and the same API contract, and it is what the test suite exercises.

---

## The free tier

Space Bunny Alpha is a 1,000,000-token-context model. It is reached through
OpenRouter, which speaks the standard `/chat/completions` shape, so it reuses
the same OpenAI-compatible adapter as every other vendor.

**There is no anonymous public Space Bunny endpoint.** Every documented route —
OpenRouter, BeatAPI, and the various third-party resellers — requires an API
key, and free tiers are typically capped at a handful of requests per minute
per account. That is why the key lives on the server:

- a visitor never has to obtain one;
- the key is never exposed to the browser;
- the per-owner and per-IP rate limits are what keep it from being drained.

Set `AI_REASONING_EFFORT` to `low`…`max` to control reasoning depth. Leave it
empty to omit the field — gateways that do not recognise it reject the request.

---

## Bring your own key

`GPT-4o`, `Gemini`, `Claude`, `DeepSeek` and `Groq` are presets in
`src/providers/presets.ts`. Selecting one sends your saved key with the request:

| Header | Required | Purpose |
| --- | --- | --- |
| `X-Provider-Key` | yes | Your API key. |
| `X-Provider-Base-Url` | no | Point at a self-hosted OpenAI-compatible server. |
| `X-Provider-Model` | no | Pin a specific model id. |

**The key is never stored by the server.** It is read from the request, handed
to a provider instance that lives only for that request, and discarded. It is
never written to the database, never logged, and never echoed in a response or
an error. Browser-side, it lives only in IndexedDB on your device.

A known label with no key returns `400 {"code":"missing_api_key"}`; an unknown
label returns `400 {"code":"unknown_model"}`.

---

## API

| Method | Path | Availability | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/health` | Both | Liveness, active provider, whether demo mode is on. |
| `POST` | `/api/chat` | Both | Send a message; streams the reply as SSE. |
| `POST` | `/api/image` | Both | Generate an image. Requires a BYOK key. |
| `GET` | `/api/auth/me` | Express only | The signed-in user, or `null`. |
| `POST` | `/api/auth/signup` | Express only | Create an account. |
| `POST` | `/api/auth/login` | Express only | Start a session. |
| `POST` | `/api/auth/logout` | Express only | End the session. |
| `GET` | `/api/conversations` | Express only | List conversations. |
| `GET` | `/api/conversations/:id` | Express only | One conversation with its messages. |
| `PATCH` | `/api/conversations/:id` | Express only | Rename. |
| `DELETE` | `/api/conversations/:id` | Express only | Delete. |

The frontend treats the Express-only endpoints as optional: when they 404 it
falls back to guest mode with local-only history, which is what makes the same
build work on Vercel.

### `POST /api/chat`

```json
{ "message": "Hello", "model": "SpaceBunny Free MAX", "history": [] }
```

The reply streams back as Server-Sent Events:

```text
event: meta
data: {"model":"stealth/space-bunny-alpha"}

event: delta
data: {"text":"Hello"}

event: done
data: {"content":"Hello there"}
```

A failure before the first token is a real non-2xx JSON error, carrying the
upstream vendor's own status and message. A failure *after* streaming starts
arrives as `event: error`, and any text already generated is kept.

Over the rate limit the endpoint answers `429` with `Retry-After` before writing
anything. The UI shows that as a toast with a countdown plus an inline retry.

---

## Configuration

Every variable is documented in `.env.example`. The ones that matter most:

| Variable | Default | Notes |
| --- | --- | --- |
| `AI_PROVIDER` | *(empty)* | Empty auto-selects: real provider if a key exists, `mock` if not. |
| `AI_API_KEY` | *(empty)* | The deployment's key. This is the one you need. |
| `AI_MODEL` | `stealth/space-bunny-alpha` | Free-tier model id. |
| `AI_BASE_URL` | `https://openrouter.ai/api/v1` | Swap to hit another gateway. |
| `AI_REASONING_EFFORT` | *(empty)* | `low`…`max`. Omitted when empty. |
| `TRUST_PROXY` | `0` | See the warning below. |
| `CORS_ORIGINS` | localhost only | Comma-separated allowlist. |

### `TRUST_PROXY` matters

It is **off by default**, and that default is load-bearing. Any non-zero value
makes Express believe the `X-Forwarded-For` header — which the client controls
— when resolving `req.ip`, so a visitor could forge a new address on every
request and walk straight through the per-IP rate limit. Turn it on only when
the app genuinely sits behind a proxy you control, and set it to the number of
proxies in front of it.

---

## Security notes

- The static file server mounts an **allowlist** (`css/`, `js/`, `icons/`,
  `components/`, `manifest.json`, `sw.js`), never the repository root. Serving
  the root would expose `data/chatbot.db` — every user's password hash, session
  token hash and message — along with `src/`, `test/` and `node_modules/`.
- Passwords use scrypt from `node:crypto`. Sessions store only a SHA-256 hash of
  the token, in an `httpOnly`, `sameSite=lax` cookie.
- Failed logins verify against a dummy hash when the account does not exist, so
  response time does not reveal which emails are registered.
- All model output is sanitised with DOMPurify before it reaches the DOM.
  KaTeX runs with `trust: false`, which is what blocks `\href` and `\htmlClass`
  from injecting markup.
- `.env` is gitignored and excluded from the Vercel deployment.

---

## Development

```bash
npm run dev        # watch mode
npm run typecheck  # tsc --noEmit
npm test           # node --test
```

The suite covers the SSE contract, validation, attachments, conversation CRUD
and ownership, auth, rate limiting, CORS, provider auto-selection, the
serverless handlers, static-file exposure, and the LaTeX delimiter rules.

### Layout

```
index.html              app shell
css/style.css           all styling, dark and light
js/ui.js                toasts, error boundary, server-status banner
js/markdown-math.js     LaTeX extraction and rendering (unit tested)
js/script.js            the chat application
sw.js                   service worker
api/                    Vercel serverless functions (stateless)
src/                    Express server, providers, SQLite, auth
test/                   node:test suite
```

---

## Not implemented

Stated plainly rather than left to look finished:

- Email verification and password reset (Express build only).
- Google / GitHub / Apple sign-in buttons say so instead of failing silently.
- The Settings panels for Billing, Usage, Analytics, 2FA and password change
  are presentational; they do not call a billing or identity service.
- Plugins and Skills menus are placeholders.

---

## License

No license has been specified yet. Add one before distributing this or
accepting external contributions.