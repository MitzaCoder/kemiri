---
name: serve-apps
description: Publish a live HTTP app from this backend and give the owner an address their devices can open. Use when the task needs a live preview rather than screenshots or an HTML artifact.
---

# Serve apps

- Choose a free port and say which port in the task report.
- Bind to the address from the Apps instruction line. Name the address explicitly; `localhost` can resolve to either IPv4 or IPv6.
- The app opens under another host name, possibly over HTTPS and on another port. If the app checks the Host header, allow the name returned by `app_publish`. Hot-reload clients need the public port and `wss` when the link uses HTTPS.
- A page that calls an API at `http://localhost:…` calls the reader's device. Use relative URLs through the app's proxy, or publish the API too and configure its public address.
- Keep the process alive past the tool call, for example with `setsid -f … < /dev/null`. Keep its first log.
- Use `app_publish` to register the port. If approval is needed, there is no link until the owner allows the app in Running apps. If no address is configured, attach screenshots or an HTML artifact instead.
- Fetch the returned URL once from the server to confirm it answers before putting it in the report. Never report a localhost link to the owner.
- Unpublish and stop what was started when the task says so. Unpublishing doesn't stop the process. Never kill a process started by someone else.
- Never publish a database, an admin console or anything holding real data or secrets.
