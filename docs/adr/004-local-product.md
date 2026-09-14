# Local application on the designer's PC

The owner explicitly chose a complete application running locally on this Windows PC. This supersedes the original specification's studio-hosted server, Postgres, account administration and multiuser deployment for the current product.

## Runtime and startup

React/Vite supplies the editor. Fastify serves its production build and local API from `127.0.0.1:4317`; it does not listen on the studio network. Core tracing, geometry and indexed rendering remain shared TypeScript. Browser workers keep editing responsive, and server exports run in a worker thread using that same core.

Double-click `Start-JDM.cmd` to start the app. It invokes `scripts/start-local.ps1`, which finds Node and pnpm, including this PC's installed Codex runtime when they are absent from Explorer's PATH. Dependencies are installed only when required packages or the installed lockfile are missing/out of date. The app is built only when required outputs are absent or app sources/configuration are newer. Normal launches of an up-to-date installation do not need the internet.

The launcher reuses an already healthy local JDM server. It never kills or replaces a process occupying port 4317. A per-workspace mutex prevents simultaneous launchers from racing through installation/startup. New server processes start hidden, with logs under `data/jdm/logs`; the default browser opens after the health check succeeds. Closing the browser leaves the local server running for the next visit. `-NoBrowser` on the PowerShell script performs the same startup checks without opening a browser.

Before making a filesystem backup, save all open designs, wait for saves and exports to finish, and close the editor tabs. Double-click `Stop-JDM.cmd`, then copy the whole `data/jdm` folder after it reports that JDM stopped. The stop script checks the loopback listener, Node executable and exact absolute server command for this workspace before stopping that process; another application or project on port 4317 is refused. `scripts/stop-local.ps1 -CheckOnly` verifies ownership without stopping anything. Stopping the server does not flush unsaved browser edits, so complete saves first. Use `Start-JDM.cmd` to reopen it.

The launcher uses the workspace's `data/jdm` and production web build. Advanced manual startup through the server entry may instead use `JDM_DATA_DIR`, `JDM_STATIC_DIR` and `JDM_PORT`. Server defaults resolve from its project location, independently of the terminal's working directory.

## Persistence and editing

`data/jdm` contains workspace settings, current document records, original PNGs, thumbnails, retained versions and indexed exports. Storage writes a temporary file, flushes its contents, then atomically replaces the committed file. Mutations are serialized and compare the client's expected revision with the stored revision. A conflicting save is rejected rather than overwriting newer work.

The browser maintains recovery drafts while edits or saves are pending. Document revisions and timestamps are assigned by the server. Five-minute renewable editor locks protect separate active clients on this PC; they are coordination between tabs, not account authentication. Locks expire and are reset when the server restarts.

A size variant stores its own frozen master copy, parent master ID, base version, machine profile, output size, operation history, cleanup settings and pixel corrections. Later parent edits do not change an existing size. Creating a size copies the currently saved draft; save an explicit version first when the base label must identify a retained snapshot exactly. Explicit saves and restores retain snapshots, and restore creates a new version. Archiving retains the underlying files. The archived library lists those records with thumbnails, and recovery checks the stored revision before returning a design to the active library with its versions and assets intact.

Exports capture the requested document revision and profile before entering the local export queue. Editing and autosaving can continue while the worker renders that frozen revision. Export completion appends history without replacing newer document edits. BMP, PNG and JSON downloads are routed through generated IDs; the API does not accept arbitrary filesystem paths. Source PNGs are retained independently of edits.

## Local request boundary

API requests require a localhost Host header. Browser Origin checks reject requests from external sites, and uploads, document geometry, operations, six-color palettes and output dimensions are validated. No cloud account, external authentication service or public deployment is part of this local workflow.

Vite development proxy configuration must preserve the browser's localhost Host/Origin pair. The installed Vite expands string-form targets to `changeOrigin: true`, changing the forwarded Host to port 4317 while retaining an Origin on port 5173. The API correctly rejects that mismatch. Use an explicit proxy object with `target: 'http://127.0.0.1:4317', changeOrigin: false`; do not broaden the production Origin rule to solve a development proxy issue.

## Validation boundary

Local persistence, reload/recovery, editing, versions, independent variants and shared-core exports are implementation checks. They do not establish NedGraphics compatibility, actual loom profile values, design fidelity for every input or the original target of reducing cleanup work to twenty percent. Those require review with the designer's real files and software.
