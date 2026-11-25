# AWSOME HUB

A shortcut hub for local apps, external websites, and hosted static sites. Node.js 18+ is required.

    node server.js          # http://0.0.0.0:8080
    PORT=9000 node server.js
    HOST=0.0.0.0 node server.js   # agar bisa diakses dari HP / perangkat lain

- App data is stored in `data/apps.json`; uploaded logos are stored in `data/uploads/`.
- Upload an `.html` or `.htm` file from a card's edit form to host it at `/pages/...` on this server; its card opens the hosted page without starting a separate app server. HTML pages run in an isolated sandbox, separate from the hub's origin, with outbound resource loading blocked.
- Deleting a card removes its uploaded HTML, ZIP site, or logo when no other card still uses that asset.
- Upload a ZIP static site from a card's edit form; the archive must contain `index.html` at its root or within a `public/` folder, including inside a project wrapper folder. The root `index.html` takes priority; otherwise the matching `public/` folder becomes the served site root. Each ZIP site gets its own port/origin, allowing browser storage and downloads without sharing the hub's origin. Port assignments are saved in `data/site-ports.json` and restored at startup. Make sure the server firewall and network allow those dynamically assigned ports; a reverse proxy must expose them too. The site listener uses HTTP, so secure-context-only browser features still depend on the browser environment. Root-relative asset paths in HTML and CSS are adjusted to the hosted site URL. `node_modules` folders are skipped during extraction. ZIP files are limited to 100 MB, extracted sites to 150 MB and 1000 entries. Uploaded sites cannot run server-side code or make network requests.
- A numeric address is treated as a port on the same host as the hub.
- PWA installation and offline support require HTTPS or `localhost`. Installation is unavailable over plain HTTP on a LAN IP.
- There is no login. Do not expose this service to the internet without an authentication layer (such as Cloudflare Access or Tailscale).
