# Copilot Code Review Instructions

When reviewing pull requests, prioritize the following five axes:

1. Security
2. Performance
3. Maintainability
4. Edge Cases & Concurrency
5. Overengineering / YAGNI

Focus on actionable findings. Prefer concrete, evidence-based comments over generic advice.

---

## 1. Security (highest priority)

Check for vulnerabilities and trust-boundary mistakes first.

- Authentication / Authorization
  - Verify authentication is enforced where required.
  - Verify authorization, including resource ownership, tenant boundaries, and role checks.
  - Look for endpoints or mutations that allow access to data outside the caller’s scope.

- Input Validation / Injection
  - Ensure untrusted input is validated, normalized, and constrained appropriately.
  - Ensure user input is not directly interpolated into SQL, NoSQL, GraphQL, shell commands, templates, or file paths.
  - Flag risks of SQL injection, NoSQL injection, command injection, template injection, path traversal, and similar issues.

- Web Security
  - XSS: ensure output is properly escaped or sanitized when rendering HTML or rich content.
  - CSRF: verify protection exists when cookie-based authentication is used.
  - CORS: flag overly permissive origins, methods, headers, or credential settings.
  - SSRF: validate and restrict any external URL fetches or webhooks.

- Secrets / Privacy / Error Handling
  - Never log tokens, API keys, credentials, secrets, or unnecessary PII.
  - Avoid exposing internal system details, stack traces, or sensitive identifiers in user-facing errors.
  - Confirm secure defaults are preserved in failure cases.

---

## 2. Performance

Look for wasteful work, scaling risks, and avoidable latency.

- Detect N+1 queries, redundant API calls, duplicate fetches, and unnecessary I/O.
- Identify unnecessary re-renders, recomputation, or overly broad invalidation.
- Check that pagination, limits, batching, and appropriate indexes are used for large datasets.
- Review timeout, retry, and backoff behavior for network or external-service calls.
- Validate client/server responsibility split to avoid unnecessary round-trips or moving heavy work to the wrong side.
- Flag performance optimizations only when they are meaningful for the expected scale or hot path.

---

## 3. Maintainability / Readability

Favor code that will still be understandable and safe to modify in six months.

- Are names expressive and responsibilities clear?
- Is any function, hook, class, or module doing too much?
- Are important assumptions implicit and therefore fragile?
- Should business rules, invariants, or edge-case handling be documented or covered by tests?
- Is the design easy to test, debug, and extend without unintended side effects?
- Prefer simple, local reasoning over cleverness.

---

## 4. Edge Cases & Concurrency

Look for correctness issues that often survive happy-path testing.

- Check null / undefined / empty arrays / empty strings / zero / max values / off-by-one boundaries.
- Review partial-failure paths and rollback or recovery behavior.
- Verify idempotency: retries must not create duplicates, double writes, or partial state.
- Check for race conditions, lost updates, duplicate processing, and ordering assumptions.
  - Look for versioning, optimistic locking, transactions, idempotency keys, or other safeguards where appropriate.
- Review time-related logic carefully:
  - time zones
  - DST
  - clock skew
  - inclusive/exclusive date boundaries
  - “now” evaluated multiple times

---

## 5. Overengineering / YAGNI

Prefer the simplest design that satisfies current requirements.

- Avoid abstractions that are not needed today.
- Avoid speculative generality and premature extensibility.
- Prefer designs that can evolve incrementally.
- Do not introduce new mechanisms when existing ones are sufficient and already understood by the team.

---

## Review Output Format

List findings using the following structure:

- Severity: High / Medium / Low
- Location: file:line
- Explanation: what is wrong and why it matters
- Fix suggestion: the smallest reasonable change that improves the issue

Additional guidance:

- Prioritize high-signal findings over exhaustive noise.
- Do not invent problems. If evidence is weak, say so clearly.
- If unsure:
  - state your assumptions
  - explain what would confirm the issue
  - propose a test or scenario to validate it
- Prefer specific review comments over broad style opinions unless the issue affects correctness, safety, or maintainability.

Language policy:

- By default, write review comments and explanations in Japanese.
- Code identifiers and common technical terms may remain in English.
- If the PR description or discussion is clearly English-only, or explicitly requests English, respond in English for that context.
