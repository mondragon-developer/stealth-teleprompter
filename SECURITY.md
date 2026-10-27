# Security boundaries

Screen Script stores API keys in the operating system keychain. Scripts and AI
notes are ordinary local files/settings, not encrypted secrets. Do not put API
keys into scripts, notes, URLs, `.env` files committed to Git, or issue reports.
The frontend clears the key field after saving or deleting; it cannot guarantee
forensic erasure of clipboard copies, process memory, backups, or past requests.

Delete saved key verifies that the keychain reports no credential. It does not
revoke the credential at the provider. Revoke it in the provider console to stop
use elsewhere. A compromised account or computer remains outside this protection.

Claude, OpenAI and Kimi keys are bound to their official HTTPS API endpoints.
The backend rejects mismatched provider formats, URL credentials, query strings,
and fragments. Custom servers require HTTPS; plain HTTP is limited to loopback.
AI requests never follow redirects. Keys cannot be read back through a frontend
command. Local voice recognition sends no audio to these providers; requesting
an answer sends the chosen text context.

The webview uses a content security policy limiting scripts to bundled code and
network connections to Tauri IPC. Script Markdown escapes HTML before rendering.
File read/write/delete commands restrict existing paths to the scripts folder.
Updater verification uses a public signing key; that public key belongs in Git.
Release signing secrets are supplied through GitHub Actions secrets.

## Dependency advisory reviewed October 27, 2026

GitHub Dependabot alert 1 identifies `glib 0.18.5` in Cargo.lock:
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html),
unsound iteration in `VariantStrIter`, fixed in glib 0.20.0.

The dependency enters through Tauri's Linux GTK3/WebKitGTK stack. Target-specific
`cargo tree -i glib` checks show it is absent from the Windows x64 and both macOS
target graphs used by this repository's release workflows. It remains in the
cross-platform lockfile and must be addressed before shipping a Linux build.
An independent glib 0.20 dependency would not replace GTK3's 0.18 dependency.
The alert remains open; do not suppress it or claim the dependency was patched.
Follow the [upstream migration](https://github.com/tauri-apps/tauri/issues/12564).

## Checks

Run `npm test`, `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib`,
and `npm audit`. If installed, `gitleaks git . --redact --log-opts="--all"` checks
reachable Git history without printing matched secrets. A clean scan does not
prove the absence of every secret or vulnerability. Build and release CI run the
JavaScript and Rust regression tests before producing installers.

Local progress notes, marketing drafts, assistant state, editor history, and
common credential files are ignored. Removing a tracked document does not erase
it from past Git commits; this cleanup does not rewrite published history.
