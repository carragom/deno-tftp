/**
 * Concrete TFTP client and server APIs for Deno.
 *
 * This module is pre-1.0. The public API is expected to change while the
 * protocol surface and interoperability behavior settle.
 *
 * Supported protocol scope:
 *
 * - RFC 1350
 * - RFC 2347
 * - RFC 2348
 * - RFC 2349
 * - RFC 3617 for CLI URI input
 * - RFC 7440
 *
 * Built-in server dispatch order:
 *
 * 1. serve an existing regular file under `root`
 * 2. call the custom handler or router
 * 3. call the user default handler
 * 4. return a built-in TFTP error
 *
 * Built-in filesystem handling is conservative:
 *
 * - only regular files are served
 * - symlinks are rejected
 * - overwrites are disabled by default
 * - new file creation is enabled by default
 * - directory creation is disabled by default
 *
 * @example Download a remote file
 *
 * ```ts
 * import { Client, OperationTimeoutError } from './mod.ts'
 *
 * const client = new Client({ host: '127.0.0.1', port: 1069 })
 *
 * try {
 *   const response = await client.get('boot/kernel.img')
 *
 *   if (!response.ok) {
 *     console.error('remote TFTP error:', response.error?.code, response.error?.message)
 *     Deno.exit(1)
 *   }
 *
 *   await response.body?.pipeTo(Deno.stdout.writable)
 * } catch (error) {
 *   if (error instanceof OperationTimeoutError) {
 *     console.error('local timeout while talking to the server')
 *     Deno.exit(1)
 *   }
 *
 *   throw error
 * }
 * ```
 *
 * @example Upload a local stream
 *
 * ```ts
 * import { Client, OperationTimeoutError } from './mod.ts'
 *
 * const client = new Client({ host: '127.0.0.1', port: 1069 })
 * const file = await Deno.open('firmware.bin', { read: true })
 *
 * try {
 *   const response = await client.put('uploads/firmware.bin', file.readable)
 *   file.close()
 *
 *   if (!response.ok) {
 *     console.error('remote TFTP error:', response.error?.code, response.error?.message)
 *     Deno.exit(1)
 *   }
 * } catch (error) {
 *   file.close()
 *   if (error instanceof OperationTimeoutError) {
 *     console.error('local timeout while talking to the server')
 *     Deno.exit(1)
 *   }
 *
 *   throw error
 * }
 * ```
 *
 * @example Use the advanced request API
 *
 * ```ts
 * import { Client, OperationTimeoutError } from './mod.ts'
 *
 * const client = new Client({ host: '127.0.0.1', port: 1069 })
 *
 * try {
 *   const response = await client.request('boot/kernel.img', 'GET', {
 *     options: { blksize: 1468, windowsize: 4 },
 *   })
 *
 *   if (!response.ok) {
 *     console.error('remote TFTP error:', response.error?.code, response.error?.message)
 *     Deno.exit(1)
 *   }
 *
 *   await response.body?.pipeTo(Deno.stdout.writable)
 * } catch (error) {
 *   if (error instanceof OperationTimeoutError) {
 *     console.error('local timeout while talking to the server')
 *     Deno.exit(1)
 *   }
 *
 *   throw error
 * }
 * ```
 *
 * @example Expose a `tftproot` folder
 *
 * ```ts
 * import { Server } from './mod.ts'
 *
 * const server = new Server({
 *   host: '0.0.0.0',
 *   port: 1069,
 *   root: './tftproot',
 * })
 *
 * await server.listen()
 * ```
 *
 * @example Use an inline handler and a default handler
 *
 * When `root` is configured, the server checks it first. Existing regular files
 * under `./tftproot` are served before the inline handler runs. If the root
 * does not produce a response, the inline handler runs next, and the default
 * handler is used last.
 *
 * ```ts
 * import { Server, TFTPError, TFTPErrorCode } from './mod.ts'
 *
 * const server = new Server(
 *   { host: '127.0.0.1', port: 1069, root: './tftproot' },
 *   async (request, _info) => {
 *     if (request.method === 'GET' && request.path === 'motd.txt') {
 *       return {
 *         body: ReadableStream.from([
 *           new TextEncoder().encode('hello from the handler\n'),
 *         ]),
 *       }
 *     }
 *     return {}
 *   },
 *   async (_request, _info) => ({
 *     error: new TFTPError(TFTPErrorCode.FILE_NOT_FOUND, 'File not found'),
 *   }),
 * )
 *
 * await server.listen()
 * ```
 *
 * @example Use the `route()` helper
 *
 * ```ts
 * import { Server, route, TFTPError, TFTPErrorCode } from './mod.ts'
 *
 * const handler = route([
 *   {
 *     method: 'GET',
 *     pattern: new URLPattern({ pathname: '/dynamic/:name' }),
 *     handler: async (_request, params, info) => ({
 *       body: ReadableStream.from([
 *         new TextEncoder().encode(
 *           `hello ${params.pathname.groups.name} from ${info.remote.address}\n`,
 *         ),
 *       ]),
 *     }),
 *   },
 * ], async (_request, _info) => ({
 *   error: new TFTPError(TFTPErrorCode.FILE_NOT_FOUND, 'File not found'),
 * }))
 *
 * const server = new Server({ host: '127.0.0.1', port: 1069 }, handler)
 * await server.listen()
 * ```
 *
 * @module
 */

export { Client } from './src/client.ts'
export type {
	ClientGetOptions,
	ClientOptions,
	ClientPutOptions,
	ClientRequestPutOptions,
} from './src/client.ts'
export {
	OperationTimeoutError,
	TFTPError,
	TFTPErrorCode,
	TFTPRemoteError,
} from './src/common.ts'
export type {
	TFTPMethod,
	TFTPMode,
	TFTPOptions,
	TFTPRequest,
	TFTPRequestInit,
	TFTPResponse,
	TFTPResponseInit,
} from './src/common.ts'
export { route, Server } from './src/server.ts'
export type {
	ServerOptions,
	TFTPEndpoint,
	TFTPRequestHandler,
	TFTPRoute,
	TFTPRouteHandler,
	TFTPServeHandlerInfo,
} from './src/server.ts'
