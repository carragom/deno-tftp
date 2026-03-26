# deno-tftp

Pre-1.0 TFTP client and server for the Deno runtime, implemented in TypeScript.

This project aims to provide a programmatic library and CLI tools for TFTP
transfers while keeping the API shaped around TFTP itself instead of forcing
HTTP request/response semantics.

Status: pre-1.0. Expect API changes while the core client, server, and
interoperability surface settles.

## Scope

The implementation targets these RFCs:

- RFC 1350 - TFTP base protocol
- RFC 2347 - option negotiation
- RFC 2348 - blocksize option
- RFC 2349 - timeout and transfer size options
- RFC 3617 - TFTP URI syntax for the CLI
- RFC 7440 - windowsize option

Block number rollover follows the common default behavior of wrapping from
`65535` to `0`. The library does not advertise or negotiate the non-standard
`rollover` option automatically.

Conservative built-in server defaults:

- only serves existing regular files under `root`
- never follows symlinks
- rejects overwriting files by default
- allows creating new files by default
- does not create parent directories unless configured

## Use This Repo

This repository is a Deno package with `mod.ts` as its public entrypoint. Import
from the repo root when using it locally:

```ts
import { Client, Server } from './mod.ts'
```

For local development, use the built-in Deno tools:

```sh
deno fmt
deno lint
deno check mod.ts
deno test -P
```

## Library Usage

Download a remote file:

```ts
import { Client } from './mod.ts'

const client = new Client({ host: '127.0.0.1', port: 69 })
const response = await client.get('boot/kernel.img')

if (!response.body) throw new Error('Missing response body')
await response.body.pipeTo(Deno.stdout.writable)
```

Upload a local stream:

```ts
import { Client } from './mod.ts'

const client = new Client({ host: '127.0.0.1', port: 69 })
const file = await Deno.open('firmware.bin', { read: true })

await client.put('uploads/firmware.bin', file.readable)
file.close()
```

Use the advanced request API:

```ts
import { Client } from './mod.ts'

const client = new Client({ host: '127.0.0.1', port: 69 })
const response = await client.request('boot/kernel.img', 'GET', {
	options: { blksize: 1468, windowsize: 4 },
})

if (!response.body) throw new Error('Missing response body')
await response.body.pipeTo(Deno.stdout.writable)
```

Serve files from a root directory:

```ts
import { Server } from './mod.ts'

const server = new Server(undefined, {
	host: '0.0.0.0',
	port: 69,
	root: '.',
})

await server.listen()
```

Use routing plus a default handler:

```ts
import { route, Server, TFTPError, TFTPErrorCode } from './mod.ts'

const handler = route([
	{
		method: 'GET',
		pattern: new URLPattern({ pathname: '/dynamic/:name' }),
		handler: async (_request, params) => ({
			body: ReadableStream.from([
				new TextEncoder().encode(`hello ${params.pathname.groups.name}\n`),
			]),
		}),
	},
], async () => ({
	error: new TFTPError(TFTPErrorCode.FILE_NOT_FOUND, 'File not found'),
}))

const server = new Server(handler, { host: '127.0.0.1', port: 1069 })
await server.listen()
```

## CLI Usage

Run the CLIs from this repository with Deno:

Fetch to stdout:

```sh
deno run -A src/tftp.ts get tftp://127.0.0.1:1069/file.dat
```

Fetch to a file:

```sh
deno run -A src/tftp.ts get tftp://127.0.0.1:1069/file.dat local.dat
```

Upload from stdin:

```sh
cat local.dat | deno run -A src/tftp.ts put tftp://127.0.0.1:1069/file.dat
```

Upload from a file:

```sh
deno run -A src/tftp.ts put tftp://127.0.0.1:1069/file.dat local.dat
```

Start the server:

```sh
deno run -A src/tftpd.ts --host 0.0.0.0 --port 1069 --root .
```

## Tests

Run the unit and self-contained integration tests:

```sh
deno test -P
```

The test suite is designed to be safe for parallel execution. For a faster local
run, use:

```sh
deno test -P --parallel
```

`src/transport_test.ts` covers wire-level UDP and TFTP edge cases such as OACK
validation, partial-window acknowledgments, duplicate or out-of-order packets,
unknown transfer IDs, and transfer-size mismatch handling.

Optional interoperability tests are enabled with environment variables:

- `TEST_INTEROP_CLIENT=y|yes` enables tests that drive this server with external
  TFTP clients found in `PATH`
- `TEST_INTEROP_SERVER=<host>[:port][,<host>[:port]...]` enables tests that
  drive one or more external TFTP servers with this client

If a `TEST_INTEROP_SERVER` entry omits a port, port `69` is used. The external
server fixture is expected to expose a readable `hello.txt` file containing
`hello\n`.

When `TEST_INTEROP_CLIENT` is enabled, the suite runs separate client interop
tests for `atftp` and `tftp` when those binaries are available in `PATH`.
`atftp` also covers negotiated server options such as `blksize`, `timeout`,
`windowsize`, and `tsize`.

Examples:

```sh
TEST_INTEROP_CLIENT=yes deno test -P src/integration_test.ts
TEST_INTEROP_SERVER=127.0.0.1:1069,127.0.0.1:2069 deno test -P src/integration_test.ts
```

When `TEST_INTEROP_SERVER` is set, the integration suite also checks negotiated
`blksize`, `windowsize`, and `tsize` behavior against each configured external
server.

When `TEST_INTEROP_CLIENT` is set, the integration suite checks both download
and upload against this server using a temporary writable root.

GitHub Actions installs `atftp`, `atftpd`, and `tftp-hpa`. CI runs the main test
suite, drives `atftpd` as an external server, and drives this server with both
`atftp` and `tftp` when those clients are present.
