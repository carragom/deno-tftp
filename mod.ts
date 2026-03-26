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
 * Download a file:
 *
 * ```ts
 * import { Client } from './mod.ts'
 *
 * const client = new Client({ host: '127.0.0.1', port: 1069 })
 * const response = await client.get('boot/kernel.img')
 * await response.body?.pipeTo(Deno.stdout.writable)
 * ```
 *
 * Upload a stream:
 *
 * ```ts
 * import { Client } from './mod.ts'
 *
 * const client = new Client({ host: '127.0.0.1', port: 1069 })
 * const file = await Deno.open('firmware.bin', { read: true })
 * await client.put('uploads/firmware.bin', file.readable)
 * file.close()
 * ```
 *
 * Start a root-backed server:
 *
 * ```ts
 * import { Server } from './mod.ts'
 *
 * const server = new Server(undefined, {
 *   host: '0.0.0.0',
 *   port: 1069,
 *   root: '.',
 * })
 *
 * await server.listen()
 * ```
 *
 * Use routing and stream an HTTP response body:
 *
 * ```ts
 * import { Server, route, TFTPError, TFTPErrorCode } from './mod.ts'
 *
 * const handler = route([
 *   {
 *     method: 'GET',
 *     pattern: new URLPattern({ pathname: '/proxy/*' }),
 *     handler: async (request) => {
 *       const response = await fetch(`https://example.com/${request.path}`)
 *       if (!response.ok || !response.body) {
 *         return {
 *           error: new TFTPError(TFTPErrorCode.FILE_NOT_FOUND, 'File not found'),
 *         }
 *       }
 *       return { body: response.body }
 *     },
 *   },
 * ], async () => ({
 *   error: new TFTPError(TFTPErrorCode.FILE_NOT_FOUND, 'File not found'),
 * }))
 *
 * const server = new Server(handler, { host: '127.0.0.1', port: 1069 })
 * await server.listen()
 * ```
 *
 * @module
 */

export * from './src/common.ts'
export { Client } from './src/client.ts'
export { route, Server } from './src/server.ts'
