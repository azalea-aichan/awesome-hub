# AWSOME HUB

A shortcut hub for local apps and external websites. No dependencies required; Node.js 18+ is enough.

    node server.js          # http://0.0.0.0:8080
    PORT=9000 node server.js
    HOST=0.0.0.0 node server.js   # agar bisa diakses dari HP / perangkat lain

- App data is stored in `data/apps.json`; uploaded logos are stored in `data/uploads/`.
- Upload an `.html` or `.htm` file from a card's edit form to host it at `/pages/...` on this server; its card opens the hosted page without starting a separate app server. HTML pages run in an isolated sandbox, separate from the hub's origin, with outbound resource loading blocked.
- A numeric address is treated as a port on the same host as the hub.
- PWA installation and offline support require HTTPS or `localhost`. Installation is unavailable over plain HTTP on a LAN IP.
- There is no login. Do not expose this service to the internet without an authentication layer (such as Cloudflare Access or Tailscale).
