# SARA — Smart Adaptive Response Assistant

A resilient, full-stack AI chatbot built for the Lyftr AI Full-Stack Assignment. SARA keeps separate multi-turn conversations in SQLite, fails over between provider keys, and caches repeat prompts through LiteLLM.

## Live URLs

- Frontend: _Deploy the `frontend` directory and add the public backend URL as `VITE_API_BASE_URL` at build time._
- Backend: _Deploy the `backend` directory with a persistent volume mounted at `/data`._
- GitHub: https://github.com/varchasv2005/Lyftr-AI-Assignment

## Run locally: with Docker and without

### With Docker

1. Copy `.env.example` to `.env` and provide at least two valid provider keys in `LLM_API_KEYS`.
2. Run `make up` from the repository root. Docker Compose starts the API at `http://localhost:8000` and the app at `http://localhost:3000`. SQLite persists in the named `sara-data` volume.
3. Run `make down` to stop the stack.

### Without Docker

1. Create a Python 3.12 virtual environment, install `backend/requirements.txt`, and set the variables from `.env.example` in your shell.
2. Start the API with `uvicorn main:app --app-dir backend --reload --port 8000`.
3. In another terminal, run `cd frontend`, `npm install`, then `npm run dev -- --port 3000`.

## Design decisions: key fallback, caching, SQLite session storage

- **Key fallback:** `LLM_API_KEYS` is tried in order. Rate-limit, quota, and transient 5xx failures advance to the next key. The response reports only a safe key identifier, never the secret. Failed requests are not written to history.
- **Caching:** LiteLLM's built-in in-memory cache is enabled by default. Its cache key incorporates the selected model and the complete prompt message list (system prompt plus conversation history and new message), so exact repeat prompts can be served from cache.
- **SQLite:** Messages are persisted in the Docker named volume under `/data/app.db`; the schema and index are created at startup. The system prompt is sent to the model but never saved to history.
- **Tokens and latency:** Each assistant reply carries provider usage for that request and server-measured latency. A cache hit keeps the cached response's usage and reports `key_id: null`.
- **Privacy:** API keys come only from environment variables. CORS is limited to the configured origins. Failure simulation can be disabled outside demonstration environments.

## Verification: how to see failover, cache hits and per-message token usage

- Open `/health` to confirm the database and number of configured keys.
- Send the same first message in two fresh browser sessions. The second request should report `LLM_CACHE`; replies are identical and token counts belong to that request.
- Add `X-Simulate-Failure: key_1=429` to a `POST /chat` request. With two keys, SARA tries the second key and reports `fallback_attempts: 1`.
- Add `X-Simulate-Failure: *=429`. SARA returns `503 {"detail":"all providers unavailable"}` and does not create session history.
- Inspect each assistant reply's source, model, latency, input-token, and output-token badges in the UI. Call `/sessions/{session_id}/messages` to see stored user and assistant turns without the system prompt.
- Run the backend suite with `python -m unittest discover -s backend`.

## Setup Used: your editor and AI tools

Built with Visual Studio Code and OpenAI Codex as an AI coding assistant. The assignment permits AI tools and documentation.

## Bonus features (if any): what you added beyond the requirements and why

- Optional per-session system prompt editor.
- Responsive, accessible chat interface with suggested prompts, backend health indicator, conversation copy, and readable retry guidance.
- Server-side validation and explicit JSON errors for unavailable providers.

## API

- `GET /health`
- `POST /chat` with `{ "session_id": "...", "message": "...", "system_prompt": "..." }`
- `GET /sessions/{session_id}/messages`

See the assignment brief for the complete request and response contract. Never place real API keys in source control.
