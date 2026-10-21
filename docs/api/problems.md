# API problem types

Every error response of the ClubAdmin API is an
[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem-details document
with content type `application/problem+json`:

```json
{
  "type": "https://github.com/SweRavn/ClubAdmin/blob/main/docs/api/problems.md#validation",
  "title": "The request contains invalid data",
  "status": 400,
  "instance": "/api/v1/groups",
  "requestId": "01a15b16-a3bc-75b3-a9d3-4c6acce5e10f",
  "errors": [{ "location": "body", "path": "name", "code": "too_small", "message": "Too small: expected string to have >=1 characters" }]
}
```

- `type` links to the section below; clients should switch on the part after `#`.
- `title` is translated from `Accept-Language` (Swedish, English).
- `detail` (optional) explains this occurrence. It never contains personal data.
- `requestId` matches the `X-Request-Id` response header and the server logs.
  Include it when reporting a problem.
- Error responses never contain stack traces, SQL, or the submitted values.

| Type | Status | Meaning |
|---|---|---|
| <a id="bad-request"></a>`bad-request` | 400 | Malformed request, e.g. invalid JSON |
| <a id="validation"></a>`validation` | 400 | Request does not match the schema; see `errors` |
| <a id="unauthenticated"></a>`unauthenticated` | 401 | Not logged in, or the session expired |
| <a id="forbidden"></a>`forbidden` | 403 | Logged in but not allowed |
| <a id="mfa-required"></a>`mfa-required` | 403 | The endpoint needs a login with a second factor (passkey or one-time code); `detail` is `mfa_required`. Clients start a step-up login. |
| <a id="reauthentication-required"></a>`reauthentication-required` | 403 | The endpoint needs a recent login (`detail` `recent_auth_required`); clients ask the user to log in again. |
| <a id="not-found"></a>`not-found` | 404 | Resource does not exist, or you may not know that it exists |
| <a id="method-not-allowed"></a>`method-not-allowed` | 405 | HTTP method not supported for this resource |
| <a id="conflict"></a>`conflict` | 409 | Conflicts with the current state, e.g. a concurrent change |
| <a id="payload-too-large"></a>`payload-too-large` | 413 | Request body larger than the limit (1 MB by default) |
| <a id="unsupported-media-type"></a>`unsupported-media-type` | 415 | Content type not accepted |
| <a id="rate-limited"></a>`rate-limited` | 429 | Too many requests; wait for the `Retry-After` seconds |
| <a id="internal"></a>`internal` | 500 | Unexpected error on the server (logged with the request ID) |
| <a id="not-implemented"></a>`not-implemented` | 501 | Not implemented yet |
| <a id="unavailable"></a>`unavailable` | 503 | Temporarily unavailable, e.g. during shutdown |

New types are added to `PROBLEM_TYPES` in `packages/shared/src/http/problem.ts`,
to the message catalogues in `packages/i18n/messages/`, and to this table.
