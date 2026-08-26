# Forge v1 coherence review

Date: 2026-08-26

Verdict: HOLD.

The released-build smoke harness starts after restoring the locked workspace
dependencies. Server smoke tests pass on desktop and phone projects.

The whole-app UI flow fails on both viewports. Creating a project and opening
its session shows the React error `Maximum update depth exceeded`. The message
composer does not render. This blocks chat, uploads, forks, `/btw`, and the
remaining browser flow.

The failure reproduces with:

```sh
e2e/node_modules/.bin/playwright test -c e2e/playwright.config.ts
```

The review applied two small listener-lifetime fixes in the sidebar and
composer. They did not remove the session-navigation failure. A follow-up
child must isolate the update loop before ship.

The released-binary flow could not run because this checkout has no release
artifact. The launcher uses the isolated Forge server and the repository
Playwright suite instead. The collaborative preview host was unavailable.

`cloc` was not installed in the review environment. The repository line-count
target remains unverified.
