# Workspace previews

Forge previews use a separate listener and a scoped URL:

`<public-origin>/preview/<target-id>/...`

The server registers only HTTP or HTTPS loopback origins. It rejects embedded
credentials, unsupported schemes, path components, and redirect escapes. Each
target stores the session workspace ID and revision captured during registration.

Preview requests do not receive Forge `Cookie` or `Authorization` headers. The
transport preserves upstream content security and frame policy headers. It does
not rewrite HTML or claim that an iframe loaded successfully.

The browser should use a separate host, such as `127.0.0.2`, with a sandbox that
allows scripts and same-origin storage. A separate port on `127.0.0.1` is not an
isolation boundary because host cookies remain available. Opaque sandbox origins
break module loading and local storage for services that do not support a null
origin. Service workers and credential sharing are not supported by this web
transport. Restricted external pages stay direct browser targets.

The transport limits registered targets, active connections, redirects, and
request bodies. Removing a target closes only Forge transport state. It does not
terminate the independently started development server.
