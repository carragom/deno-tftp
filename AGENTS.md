# AGENTS.md

This repository contains a pre-1.0 TFTP client and server for Deno written in
TypeScript.

## Project Rules

- Keep the API shaped around TFTP, not web `Request` and `Response`
- Use the public types from `mod.ts` as the source of truth for API shape
- Export the public client/server APIs from `mod.ts`
- Keep the project clearly marked pre-1.0 in docs

## Protocol Scope

The implementation targets:

- RFC 1350
- RFC 2347
- RFC 2348
- RFC 2349
- RFC 3617
- RFC 7440

Reference texts live in `docs/`.

## Server Dispatch Order

The built-in server dispatch order is fixed:

1. If `root` is defined and the requested path resolves to an existing regular
   file under `root`, serve it
2. Otherwise call the custom handler or router
3. Otherwise call the user default handler
4. Otherwise return the built-in TFTP error

Do not change this order unless explicitly requested.

## Built-in Filesystem Rules

- Serve only regular files
- Never follow symlinks
- Reject any path that can escape `root`
- Canonicalize `root` and validate all candidate paths against it
- For non-existing PUT targets, validate the nearest existing parent directory
  against `root`

Built-in PUT defaults:

- `allowOverwrite = false`
- `allowCreateFile = true`
- `allowCreateDir = false`
- `maxPutSize = undefined`

When enabled, `allowCreateDir` creates directories recursively.

Protocol-oriented error expectations:

- missing GET target -> code `1`
- denied or invalid PUT target -> code `2`
- PUT to existing file when overwrite is disabled -> code `6`
- max PUT size exceeded -> code `3`

## Client Rules

- `Client.request()` is the advanced API
- The client instance owns the remote host and port
- Do not allow callers to override the remote endpoint through a request object
- `Client.get()` and `Client.put()` operate on TFTP paths, not URIs

## Tests

Unit-only test files:

- `src/client_test.ts`
- `src/server_test.ts`
- `src/common_test.ts`
- `src/utils_test.ts`

Integration-only test file:

- `src/integration_test.ts`

Interop gating rules:

- `TEST_INTEROP_CLIENT=atftp|tftp` enables tests that drive this server using an
  external CLI client
- `TEST_INTEROP_SERVER=<host>[:port]` enables tests that drive an external TFTP
  server using this client
- If `TEST_INTEROP_SERVER` omits a port, use port `69`
- Do not prevalidate external client availability; let the configured test fail
  naturally if the command is missing

## CLI

Use `@cliffy/command` for both CLIs.

Client CLI shape:

- `tftp get <uri> [output]`
- `tftp put <uri> [input]`
- default output is stdout
- default input is stdin
- `-` explicitly means stdout or stdin

Server CLI shape:

- `tftpd --host ... --port ... --root ...`

## Documentation

- Keep `README.md` concrete and user-facing
- Keep `mod.ts` `@module` docs concrete and API-oriented
- Update docs when behavior changes

## Deno Workflow

Use Deno built-ins while working:

- `deno fmt`
- `deno lint`
- `deno test -P`
- `deno check`
