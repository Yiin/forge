# Request access

Forge checks HTTP requests and WebSocket upgrades against the same configured access policy.
The `terminalAccess` configuration now applies to all Forge routes.
Changing this configuration requires a server restart.

The default policy accepts loopback Host and Origin values on the actual server port.
Other loopback ports do not grant access.
Direct `createApp` callers must supply an explicit `RequestGuard`.
They can instead bind the loopback guard before serving requests.

For a reverse proxy, list the browser origin and the Host authority that the proxy sends to Forge separately:

```toml
[terminalAccess]
mode = "explicit"
allowedOrigins = ["https://forge.example"]
allowedHostAuthorities = ["backend:3773"]
```

Forge does not trust `Forwarded` or `X-Forwarded-*` headers to grant access.
An allowed backend Host does not grant its matching browser Origin.
Forge rejects duplicate, malformed, unlisted, and null Origin values.
Fetch Metadata can reject a request, but cannot grant access.

Non-browser clients can omit Origin on ordinary HTTP and transcript WebSocket requests.
They must still send an allowed Host and the endpoint's required Content-Type.
Terminal mutation and terminal WebSocket routes retain their stricter Origin requirement.
Origin checks are not authentication.

JSON mutations require `application/json`.
Raw `PUT /api/uploads/:id` requests require `application/octet-stream`.
The upload initialization request records the file's original MIME type.
Bodyless operations and DELETE requests can omit Content-Type.
The browser upload client sets the raw upload type explicitly.
