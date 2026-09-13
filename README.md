# ChatBotAI 🤖

> A friendly, intelligent conversation layer for turning ideas, questions, and workflows into meaningful interactions.

ChatBotAI is a modern chatbot project designed to make human–AI communication feel natural, useful, and approachable. Whether you are building a personal assistant, customer-support experience, productivity tool, or experimental AI companion, this project provides a clear foundation for creating engaging conversations.

## ✨ What It Does

- 💬 Understands and responds to natural-language messages
- 🧠 Supports context-aware conversations
- ⚡ Helps users find answers quickly
- 🛠️ Provides a flexible foundation for customization
- 🌱 Can grow from a simple chatbot into a complete AI assistant

## 🎯 Vision

ChatBotAI aims to make intelligent technology feel less like a machine and more like a helpful teammate. The goal is simple: create conversations that are clear, useful, respectful, and easy to extend.

## 🚀 Getting Started

### Prerequisites

- **Node.js 22.5 or newer** (24+ recommended). The backend runs TypeScript directly
  and uses the built-in `node:sqlite` module, so there is no build step and no
  native database dependency to compile.
- Git.
- An API key for a model provider — optional; the default `mock` provider runs
  without one.

### Installation

```bash
git clone https://github.com/MichaelNeo1214/ChatBotAI.git
cd ChatBotAI
npm install
```

### Configuration

Copy the example environment file and edit it:

```bash
cp .env.example .env
```

The backend runs with no configuration at all — it defaults to the `mock`
provider, which streams canned replies so you can develop the frontend without
an API key. To get real answers, set `AI_PROVIDER` to one of:

| `AI_PROVIDER` | What it calls | Required settings |
| --- | --- | --- |
| `mock` | Nothing. Streams placeholder text. | none |
| `anthropic` | Claude, via the official SDK. | `AI_API_KEY`, `AI_MODEL` |
| `openai-compatible` | Any service exposing `POST /chat/completions`. | `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` |

`openai-compatible` covers OpenAI, OpenRouter, Groq, Together, DeepSeek, and
local runtimes such as Ollama and LM Studio — they all speak the same wire
format, so you switch vendors by changing `AI_BASE_URL`.

`AI_MODEL_MAP` connects the model picker in the UI to real model ids. Anything
unmapped falls back to `AI_MODEL`:

```env
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://openrouter.ai/api/v1
AI_API_KEY=sk-...
AI_MODEL=openai/gpt-4o-mini
AI_MODEL_MAP={"GPT-4o":"openai/gpt-4o","Gemini":"google/gemini-2.0-flash-001","DeepSeek":"deepseek/deepseek-chat"}
```

Never commit `.env` — it is already in `.gitignore`.

### Run the Project

```bash
npm run dev
```

This starts the API and serves the frontend from the same origin at
<http://localhost:3000>. `npm start` runs it without file watching, and
`npm run typecheck` checks types without emitting anything.

## 🔌 API

All endpoints live under `/api`. Conversations are scoped to the caller by an
`httpOnly` cookie, so each browser sees only its own history.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness, active provider, uptime. |
| `POST` | `/api/auth/signup` | Create an account and start a session. |
| `POST` | `/api/auth/login` | Start a session. |
| `POST` | `/api/auth/logout` | End the current session. |
| `POST` | `/api/auth/logout-all` | End every session for the account. |
| `DELETE` | `/api/auth/account` | Delete the account and its conversations. |
| `GET` | `/api/auth/me` | The signed-in user, or `null`. |
| `POST` | `/api/chat` | Send a message; streams the reply. |
| `GET` | `/api/conversations` | List conversations, most recent first. |
| `POST` | `/api/conversations` | Create an empty conversation. |
| `GET` | `/api/conversations/:id` | One conversation with all its messages. |
| `PATCH` | `/api/conversations/:id` | Rename a conversation. |
| `DELETE` | `/api/conversations/:id` | Delete a conversation and its messages. |

### `POST /api/chat`

```json
{ "message": "Hello", "conversationId": "optional-uuid", "model": "GPT-4o" }
```

Omit `conversationId` to start a new conversation; the response names the one
that was created. The reply streams back as Server-Sent Events:

```text
event: meta
data: {"conversationId":"...","model":"ChatBot AI"}

event: delta
data: {"text":"Hello"}

event: done
data: {"messageId":"...","content":"Hello there"}
```

A failure mid-stream arrives as `event: error` instead of `event: done`; any
text generated before the failure is still saved.

### Bring your own key

The model picker's `ChatBot AI` option uses the server's own provider and
`.env` key. Every other label uses the caller's key, sent per request:

| Header | Required | Purpose |
| --- | --- | --- |
| `X-Provider-Key` | yes, for non-default labels | The user's own API key. |
| `X-Provider-Base-Url` | no | Overrides the preset base URL. |
| `X-Provider-Model` | no | Overrides the preset model id. |

Presets live in `src/providers/presets.ts`:

| Label | Adapter | Base URL | Model |
| --- | --- | --- | --- |
| `GPT-4o` | openai-compatible | `https://api.openai.com/v1` | `gpt-4o` |
| `Gemini` | openai-compatible | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash` |
| `DeepSeek` | openai-compatible | `https://api.deepseek.com/v1` | `deepseek-chat` |
| `Claude` | anthropic | — | `claude-opus-5` |

The headers are ignored for `ChatBot AI`. An unknown label returns
`400 {"code":"unknown_model"}`; a known label with no key returns
`400 {"code":"missing_api_key","model":"<label>"}`.

**The key is never stored.** It lives only for the duration of the request: not
written to the database, not logged, and never echoed in a response or error.

## 🗄️ Data

Messages are stored in SQLite at `DATABASE_PATH` (default `./data/chatbot.db`,
which is gitignored). The schema in `src/db/schema.sql` is applied on every
boot and is idempotent, so there are no migrations to run yet.

Conversations carry an `owner_id`: the user id when signed in, otherwise an
anonymous per-browser id. That means **you can chat before creating an account**,
and signing up moves those conversations onto the new account rather than
discarding them.

## 🔑 Accounts

Email and password, with server-side sessions:

- Passwords are hashed with **scrypt** from `node:crypto` — memory-hard, and no
  native dependency to compile.
- Sessions live in the database and the cookie holds a random token; only a
  SHA-256 hash of it is stored, so a database leak does not yield usable cookies.
- The session cookie is `httpOnly` and `sameSite=lax`, and `secure` in production.
- Login and signup are rate limited per IP **and** email, so one attacker cannot
  lock out everyone behind a shared IP.
- A failed login verifies against a dummy hash when the account does not exist,
  so response time does not reveal which emails are registered.

Sign-in is optional — anonymous browsing still works.

Not implemented yet: email verification, password reset, and the Google / GitHub
/ Apple buttons, which now say so instead of silently doing nothing.

## 🧩 Suggested Capabilities

ChatBotAI can be extended with features such as:

- Conversation history and persistent memory
- Streaming responses for a faster experience
- Markdown and code rendering
- File and document analysis
- Custom system prompts and personalities
- Authentication and user profiles
- Voice input and text-to-speech output
- Tool calling and external service integrations
- Rate limiting, moderation, and usage analytics

## 🏗️ Recommended Architecture

For a maintainable implementation, separate the application into clear layers:

1. **Interface** – Presents messages, loading states, errors, and conversation history.
2. **Conversation service** – Validates requests and manages chat context.
3. **AI provider layer** – Connects to the selected model through a replaceable adapter.
4. **Data layer** – Stores users, conversations, messages, and optional memories.
5. **Safety layer** – Handles input validation, privacy, moderation, and request limits.

This structure makes it easier to change models, add features, and test individual components without rewriting the entire application.

## 💡 Example Conversation

```text
User: Help me plan my day.

ChatBotAI: Absolutely. Tell me your top priorities, available time, and any fixed appointments,
and I’ll help you turn them into a practical schedule.
```

## 🔒 Security and Privacy

When deploying ChatBotAI:

- Store credentials in environment variables or a secure secrets manager.
- Validate and sanitize user input.
- Avoid logging private conversations unnecessarily.
- Add authentication before exposing personal data.
- Apply rate limits to protect the service from abuse.
- Clearly explain how messages are processed and stored.

## 🧪 Testing

Add tests for both normal and unexpected interactions, including:

- Empty or excessively long messages
- Provider timeouts and unavailable services
- Malformed responses
- Conversation-history limits
- Authentication and authorization rules
- Sensitive or unsafe input handling

Run the test command configured by the project, for example:

```bash
npm test
```

## 🤝 Contributing

Contributions are welcome. To propose an improvement:

1. Fork the repository.
2. Create a focused branch: `git checkout -b feature/my-improvement`
3. Make and test your changes.
4. Commit with a clear message.
5. Open a pull request describing what changed and why.

Please keep pull requests focused, document new configuration, and preserve user privacy and security.

## 🗺️ Roadmap

- [x] Persist conversations and messages
- [x] Add authentication (email + password, server-side sessions)
- [ ] Email verification and password reset
- [ ] Improve conversation memory
- [ ] Add configurable assistant personalities
- [x] Support multiple AI providers
- [x] Add streaming and rich message rendering
- [ ] Introduce analytics and administration tools
- [ ] Provide production deployment examples

## 📄 License

No license has been specified yet. Add a license before distributing or accepting external contributions.

## 🌟 Final Thought

Great assistants do more than generate answers—they listen, adapt, and help people move forward. ChatBotAI is a starting point for building that kind of experience, one thoughtful conversation at a time.

## Big Thanks for Yer and Max