---
name: serve-apps
description: Publish a live HTTP app from this backend and give the owner an address their devices can open. Use when the task needs a live preview rather than screenshots or an HTML artifact.
---

# Serve apps

- Choose a free port and say which port in the task report.
- Bind to the address from the Apps instruction line. Name the address explicitly; `localhost` can resolve to either IPv4 or IPv6.
- The app opens under another host name, possibly over HTTPS and on another port. If the app checks the Host header, allow the name returned by `app_start` or `app_publish`. If it checks the full Host header, include the port from the returned URL. Hot-reload clients need the public port and `wss` when the link uses HTTPS.
- A page that calls an API at `http://localhost:…` calls the reader's device. Use relative URLs through the app's proxy, or publish the API too and configure its public address.
- Use `app_start` with the foreground command and port. Kemiri records its log and keeps the app running across service restarts when a user scope is available. Check `survivesRestart` in the result. Use `app_publish` only for an app already running outside Kemiri. If approval is needed, there is no link until the owner allows the app in Running apps. If no address is configured, attach screenshots or an HTML artifact instead.
- Fetch the returned URL once from the server to confirm it answers before putting it in the report. Never report a localhost link to the owner.
- Use `app_stop` for managed apps when the task says to stop. For an external app, `app_unpublish` removes only the link. Never kill a process started by someone else.
- Never publish a database, an admin console or anything holding real data or secrets.
