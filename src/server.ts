import { deadline, retry } from '@std/async'

import {
	decodeAckPacket,
	decodeDataPacket,
	decodeErrorPacket,
	decodeRequestPacket,
	encodeAckPacket,
	encodeDataPacket,
	encodeErrorPacket,
	encodeOptionsAckPacket,
	OperationTimeoutError,
	TFTPError,
	TFTPErrorCode,
	TFTPIllegalOperationError,
	TFTPOpcode,
	TFTPRequest,
	TFTPResponse,
	TFTPUnknownTransferIdError,
} from './common.ts'
import type {
	ParsedRequestPacket,
	TFTPMethod,
	TFTPOptions,
	TFTPRequestInit,
	TFTPResponseInit,
} from './common.ts'
import {
	assertInsideRoot,
	canonicalizeRoot,
	decodeNetascii,
	encodeNetascii,
	normalizeServerOptions,
	normalizeTFTPPath,
	readBodyToBytes,
	resolvePutTarget,
	resolveReadPath,
	streamFromBytes,
} from './utils.ts'
import type { NormalizedServerOptions } from './utils.ts'

type UdpAddr = Deno.NetAddr & { transport: 'udp' }
type UdpConn = Deno.DatagramConn & { addr: UdpAddr }

interface NegotiatedTransferOptions {
	blksize: number
	timeoutMs: number
	windowsize: number
	tsize?: number
}

const responseLogSources = new WeakMap<TFTPResponse, ServerLogSource>()

/** Network endpoint address and port pair for server APIs. */
export interface TFTPEndpoint {
	/** IP address or hostname. */
	address: string
	/** UDP port number. */
	port: number
}

/** Connection metadata passed to server handlers. */
export interface TFTPServeHandlerInfo {
	/** Remote peer endpoint. */
	remote: Readonly<TFTPEndpoint>
	/** Local listening endpoint. */
	local: Readonly<TFTPEndpoint>
}

/** Server handler function that maps a request to a TFTP response. */
export type TFTPRequestHandler = (
	request: TFTPRequest,
	info: TFTPServeHandlerInfo,
) => TFTPResponse | TFTPResponseInit | Promise<TFTPResponse | TFTPResponseInit>

/** Route handler function that receives URLPattern match details. */
export type TFTPRouteHandler = (
	request: TFTPRequest,
	params: URLPatternResult,
	info: TFTPServeHandlerInfo,
) => TFTPResponse | TFTPResponseInit | Promise<TFTPResponse | TFTPResponseInit>

/** Route definition used by the built-in server router helper. */
export interface TFTPRoute {
	/** URLPattern matched against the request path. */
	pattern: URLPattern
	/** Optional method filter for this route. */
	method?: TFTPMethod | TFTPMethod[]
	/** Route handler invoked when the pattern and method match. */
	handler: TFTPRouteHandler
}

export type ServerLogLevel = 'info' | 'warn' | 'error'

export type ServerLogSource =
	| 'server'
	| 'root'
	| 'handler'
	| 'builtin_error'
	| 'protocol'

export interface ServerLogEntry {
	level: ServerLogLevel
	event: string
	source: ServerLogSource
	method?: TFTPMethod
	path?: string
	remote?: Readonly<TFTPEndpoint>
	local?: Readonly<TFTPEndpoint>
	bytes?: number
	message?: string
	error?: TFTPError
}

export type ServerLogger = (entry: Readonly<ServerLogEntry>) => void

/** Server configuration values. */
export interface ServerOptions {
	/** Bind hostname. Defaults to `127.0.0.1`. */
	host?: string
	/** Bind port. Defaults to `69`. */
	port?: number
	/** Optional filesystem root served by the built-in file handler. */
	root?: string
	/** Deny all GET requests before routing or default handling. */
	denyGET?: boolean
	/** Deny all PUT requests before routing or default handling. */
	denyPUT?: boolean
	/** Allow overwriting existing PUT targets. Defaults to `false`. */
	allowOverwrite?: boolean
	/** Allow creating missing PUT targets. Defaults to `true`. */
	allowCreateFile?: boolean
	/** Allow recursively creating missing PUT directories. Defaults to `false`. */
	allowCreateDir?: boolean
	/** Maximum accepted PUT size in octets. */
	maxPutSize?: number
	/** Default block size offered by the server. */
	blockSize?: number
	/** Default windowsize offered by the server. */
	windowSize?: number
	/** Default local operation timeout in milliseconds. */
	timeout?: number
	/** Number of retransmission attempts for timed-out operations. */
	retries?: number
	/** Optional structured logger for server lifecycle and request events. */
	logger?: ServerLogger
}

/**
 * Stateful TFTP server.
 *
 * A server instance owns its bind options, optional built-in root-backed file
 * handling, and any custom request handlers. The built-in dispatch order is:
 *
 * 1. serve an existing regular file under `root`
 * 2. call the custom handler or router
 * 3. call the default handler
 * 4. return a built-in TFTP error response
 */
export class Server {
	#options: NormalizedServerOptions
	#handler?: TFTPRequestHandler
	#logger?: ServerLogger
	#rootReal?: string
	#socket?: UdpConn
	#loop?: Promise<void>
	#listening = false
	#sessions = new Set<Promise<void>>()

	/**
	 * Creates a TFTP server.
	 *
	 * The server is configured by `options`. You may also provide a custom
	 * handler and an optional default handler for routed setups.
	 */
	constructor(
		options: ServerOptions = {},
		handler?: TFTPRequestHandler,
	) {
		this.#options = normalizeServerOptions(options)
		this.#handler = handler
		this.#logger = options.logger
	}

	/** Bound hostname. Reflects the active socket after {@link listen}. */
	get host(): string {
		if (this.#socket) {
			return this.#socket.addr.hostname
		}
		return this.#options.host
	}

	/** Bound port. Reflects the active socket after {@link listen}. */
	get port(): number {
		if (this.#socket) {
			return this.#socket.addr.port
		}
		return this.#options.port
	}

	/** Configured filesystem root, if any. */
	get root(): string | undefined {
		return this.#options.root
	}

	/** Whether GET requests are denied before routing or default handling. */
	get denyGET(): boolean {
		return this.#options.denyGET
	}

	/** Whether PUT requests are denied before routing or default handling. */
	get denyPUT(): boolean {
		return this.#options.denyPUT
	}

	/** Whether built-in PUT handling may overwrite existing files. */
	get allowOverwrite(): boolean {
		return this.#options.allowOverwrite
	}

	/** Whether built-in PUT handling may create missing files. */
	get allowCreateFile(): boolean {
		return this.#options.allowCreateFile
	}

	/** Whether built-in PUT handling may create missing directories. */
	get allowCreateDir(): boolean {
		return this.#options.allowCreateDir
	}

	/** Maximum accepted PUT size for built-in filesystem handling. */
	get maxPutSize(): number | undefined {
		return this.#options.maxPutSize
	}

	/**
	 * Starts listening for TFTP requests.
	 *
	 * When `root` is configured, the root path is canonicalized before the server
	 * begins accepting requests.
	 */
	async listen(): Promise<void> {
		if (this.#listening) return
		if (this.#options.root) {
			this.#rootReal = await canonicalizeRoot(this.#options.root)
		}

		this.#socket = Deno.listenDatagram({
			transport: 'udp',
			hostname: this.#options.host,
			port: this.#options.port,
		}) as UdpConn
		this.#listening = true
		this.#log({
			level: 'info',
			event: 'server.listen',
			source: 'server',
			local: this.#localEndpoint(),
		})
		this.#loop = this.#acceptLoop()
	}

	/** Stops the server and waits for active sessions to settle. */
	async close(): Promise<void> {
		if (!this.#listening) return
		this.#listening = false
		this.#log({
			level: 'info',
			event: 'server.close',
			source: 'server',
			local: this.#localEndpoint(),
		})
		this.#socket?.close()
		if (this.#loop) {
			try {
				await this.#loop
			} catch {
				// Ignore receive errors caused by closing the listening socket.
			}
		}
		await Promise.allSettled(Array.from(this.#sessions))
		this.#sessions.clear()
		this.#socket = undefined
	}

	/**
	 * Evaluates how this server would respond to a request from a given remote.
	 *
	 * This is an in-process API useful for tests and advanced composition.
	 */
	async request(
		request: TFTPRequestInit,
		remote: { address: string; port: number },
	): Promise<TFTPResponse> {
		const normalizedRequest = new TFTPRequest(request)
		this.#logRequest(
			'info',
			'request.start',
			'server',
			normalizedRequest,
			remote,
		)
		const response = await this.#prepareResponse(
			normalizedRequest,
			remote,
			false,
		)
		if (response.error) {
			this.#logRequest(
				'warn',
				'request.rejected',
				responseLogSource(response),
				normalizedRequest,
				remote,
				{
					error: response.error,
				},
			)
			return response
		}
		this.#logRequest(
			'info',
			'request.complete',
			responseLogSource(response),
			normalizedRequest,
			remote,
			{
				bytes: response.options?.tsize,
			},
		)
		return response
	}

	async #prepareResponse(
		request: TFTPRequest,
		remote: { address: string; port: number },
		preflightWrite: boolean,
	): Promise<TFTPResponse> {
		const normalizedPath = normalizeTFTPPath(request.path)
		const normalizedRequest = request.with({ path: normalizedPath })
		const info: TFTPServeHandlerInfo = {
			remote,
			local: { address: this.#options.host, port: this.#options.port },
		}

		if (request.method === 'GET' && this.#options.denyGET) {
			this.#logRequest(
				'warn',
				'request.denied',
				'server',
				normalizedRequest,
				remote,
				{
					message: 'Cannot GET files',
				},
			)
			return newTFTPResponse({
				error: new TFTPError(
					TFTPErrorCode.ACCESS_VIOLATION,
					'Cannot GET files',
				),
			}, 'server')
		}
		if (request.method === 'PUT' && this.#options.denyPUT) {
			this.#logRequest(
				'warn',
				'request.denied',
				'server',
				normalizedRequest,
				remote,
				{
					message: 'Cannot PUT files',
				},
			)
			return newTFTPResponse({
				error: new TFTPError(
					TFTPErrorCode.ACCESS_VIOLATION,
					'Cannot PUT files',
				),
			}, 'server')
		}

		if (this.#rootReal) {
			const fileResponse = request.method === 'GET'
				? await this.#serveFromRoot(normalizedPath)
				: await this.#prepareWriteToRoot(normalizedPath, normalizedRequest)
			if (fileResponse) {
				this.#logRequest(
					fileResponse.error ? 'warn' : 'info',
					'request.dispatch',
					'root',
					normalizedRequest,
					remote,
					{
						error: fileResponse.error,
					},
				)
				if (
					!preflightWrite && normalizedRequest.method === 'PUT' &&
					!fileResponse.error &&
					normalizedRequest.body
				) {
					await this.#persistPutData(
						normalizedPath,
						await readBodyToBytes(normalizedRequest.body),
						normalizedRequest.options.tsize,
					)
				}
				return fileResponse
			}
		}

		if (this.#handler) {
			const response = normalizeResponse(
				await this.#handler(
					normalizedRequest,
					info,
				),
			)
			if (
				response.error || response.body || response.options ||
				response.extensions
			) {
				this.#logRequest(
					response.error ? 'warn' : 'info',
					'request.dispatch',
					'handler',
					normalizedRequest,
					remote,
					{
						error: response.error,
					},
				)
				return response
			}
		}

		this.#logRequest(
			warnLevelForBuiltInError(normalizedRequest.method),
			'request.dispatch',
			'builtin_error',
			normalizedRequest,
			remote,
		)
		return newTFTPResponse({
			error: new TFTPError(
				normalizedRequest.method === 'GET'
					? TFTPErrorCode.FILE_NOT_FOUND
					: TFTPErrorCode.ACCESS_VIOLATION,
			),
		}, 'builtin_error')
	}

	async #acceptLoop(): Promise<void> {
		const socket = this.#socket
		if (!socket) return

		while (this.#listening) {
			let received: [Uint8Array, Deno.Addr]
			try {
				received = await socket.receive()
			} catch (error) {
				if (!this.#listening) return
				throw error
			}

			const [packet, addr] = received
			const remote = addr as UdpAddr
			const remoteInfo = { address: remote.hostname, port: remote.port }
			const opcode = packet.length >= 2 ? readOpcode(packet) : -1
			if (opcode !== TFTPOpcode.RRQ && opcode !== TFTPOpcode.WRQ) {
				this.#log({
					level: 'warn',
					event: 'request.invalid',
					source: 'protocol',
					remote: remoteInfo,
					local: this.#localEndpoint(),
					message: 'Invalid request opcode',
				})
				await sendPacket(
					socket,
					encodeErrorPacket(
						new TFTPIllegalOperationError(),
					),
					remote,
				)
				continue
			}

			let parsed: ParsedRequestPacket
			try {
				parsed = decodeRequestPacket(packet)
			} catch (error) {
				if (isTFTPError(error)) {
					this.#log({
						level: 'warn',
						event: 'request.decode_error',
						source: 'protocol',
						remote: remoteInfo,
						local: this.#localEndpoint(),
						error,
					})
					await sendPacket(socket, encodeErrorPacket(error), remote)
					continue
				}
				throw error
			}

			const session = this.#runSession(parsed, remote)
			this.#sessions.add(session)
			session.finally(() => this.#sessions.delete(session))
		}
	}

	async #runSession(
		parsed: ParsedRequestPacket,
		remote: UdpAddr,
	): Promise<void> {
		const socket = Deno.listenDatagram({
			transport: 'udp',
			hostname: this.#options.host,
			port: 0,
		}) as UdpConn

		const request = new TFTPRequest({
			method: parsed.method,
			path: parsed.path,
			mode: parsed.mode,
			options: parsed.options,
			extensions: parsed.extensions,
		})
		const remoteInfo = {
			address: remote.hostname,
			port: remote.port,
		}
		this.#logRequest('info', 'request.start', 'server', request, remoteInfo)
		const response = await this.#prepareResponse(request, {
			address: remote.hostname,
			port: remote.port,
		}, true)

		try {
			if (response.error) {
				this.#logRequest(
					'warn',
					'request.rejected',
					responseLogSource(response),
					request,
					remoteInfo,
					{
						error: response.error,
					},
				)
				await sendPacket(socket, encodeErrorPacket(response.error), remote)
				return
			}

			if (parsed.method === 'GET') {
				await this.#sendReadTransfer(
					socket,
					remote,
					request,
					response,
				)
			} else {
				await this.#receiveWriteTransfer(
					socket,
					remote,
					request,
					response,
				)
			}
			this.#logRequest(
				'info',
				'request.complete',
				responseLogSource(response),
				request,
				remoteInfo,
				{
					bytes: response.options?.tsize ?? request.options.tsize,
				},
			)
		} catch (error) {
			if (isTFTPError(error)) {
				this.#logRequest(
					'error',
					'request.failed',
					'protocol',
					request,
					remoteInfo,
					{
						error,
					},
				)
				await sendPacket(socket, encodeErrorPacket(error), remote)
				return
			}
			if (error instanceof OperationTimeoutError) {
				this.#logRequest(
					'warn',
					'request.timeout',
					'protocol',
					request,
					remoteInfo,
				)
				return
			}
			throw error
		} finally {
			socket.close()
		}
	}

	async #sendReadTransfer(
		socket: UdpConn,
		remote: UdpAddr,
		request: TFTPRequest,
		response: TFTPResponse,
	): Promise<void> {
		const options = negotiatedServerOptions(
			request,
			response,
			this.#options.timeout,
		)

		if (shouldSendOack(request)) {
			await sendPacket(
				socket,
				encodeOptionsAckPacket(
					buildOackOptions(request, response, options),
					response.extensions ?? {},
				),
				remote,
			)
			const ack0 = await receiveFrom(socket, remote, options.timeoutMs)
			const ack = decodeAckPacket(ack0)
			if (ack.block !== 0) {
				throw new TFTPIllegalOperationError('Expected ACK block 0')
			}
		}

		const data = await readBodyToBytes(response.body)
		await sendDataWindows(
			socket,
			remote,
			splitIntoBlocks(
				request.mode === 'netascii' ? encodeNetascii(data) : data,
				options.blksize,
			),
			options,
			this.#options.retries,
		)
	}

	async #receiveWriteTransfer(
		socket: UdpConn,
		remote: UdpAddr,
		request: TFTPRequest,
		response: TFTPResponse,
	): Promise<void> {
		const options = negotiatedServerOptions(
			request,
			response,
			this.#options.timeout,
		)

		if (shouldSendOack(request)) {
			await sendPacket(
				socket,
				encodeOptionsAckPacket(
					buildOackOptions(request, response, options),
					response.extensions ?? {},
				),
				remote,
			)
		} else {
			await sendPacket(socket, encodeAckPacket(0), remote)
		}

		const data = await receiveDataWindows(
			socket,
			remote,
			options,
			request.options.tsize,
		)
		await this.#persistPutData(
			request.path,
			request.mode === 'netascii' ? decodeNetascii(data.data) : data.data,
			request.options.tsize,
		)
		await sendPacket(socket, encodeAckPacket(data.lastBlock), remote)
		await resendFinalAckIfNeeded(
			socket,
			remote,
			data.lastBlock,
			options,
		)
	}

	async #persistPutData(
		path: string,
		data: Uint8Array,
		declaredSize?: number,
	): Promise<void> {
		if (!this.#rootReal) {
			throw new TFTPError(TFTPErrorCode.ACCESS_VIOLATION)
		}

		const target = await resolvePutTarget(this.#rootReal, path)
		const existing = await safeLstat(target.absolutePath)
		if (existing) {
			if (existing.isSymlink) {
				throw new TFTPError(
					TFTPErrorCode.ACCESS_VIOLATION,
					'Symlinks are not allowed',
				)
			}
			if (!existing.isFile) {
				throw new TFTPError(TFTPErrorCode.ACCESS_VIOLATION)
			}
			const realPath = await Deno.realPath(target.absolutePath)
			assertInsideRoot(this.#rootReal, realPath)
			if (!this.#options.allowOverwrite) {
				this.#log({
					level: 'warn',
					event: 'request.denied',
					source: 'root',
					method: 'PUT',
					path,
					local: this.#localEndpoint(),
					message: 'Refusing to overwrite existing file',
				})
				throw new TFTPError(TFTPErrorCode.FILE_EXISTS)
			}
		} else if (!this.#options.allowCreateFile) {
			this.#log({
				level: 'warn',
				event: 'request.denied',
				source: 'root',
				method: 'PUT',
				path,
				local: this.#localEndpoint(),
				message: 'Refusing to create missing file',
			})
			throw new TFTPError(TFTPErrorCode.ACCESS_VIOLATION)
		}

		if (target.parentPath !== target.nearestExistingParent) {
			if (!this.#options.allowCreateDir) {
				this.#log({
					level: 'warn',
					event: 'request.denied',
					source: 'root',
					method: 'PUT',
					path,
					local: this.#localEndpoint(),
					message: 'Refusing to create missing parent directories',
				})
				throw new TFTPError(TFTPErrorCode.ACCESS_VIOLATION)
			}
			await Deno.mkdir(target.parentPath, { recursive: true })
		}

		const effectiveSize = declaredSize ?? data.length
		if (
			this.#options.maxPutSize !== undefined &&
			effectiveSize > this.#options.maxPutSize
		) {
			this.#log({
				level: 'warn',
				event: 'request.denied',
				source: 'root',
				method: 'PUT',
				path,
				local: this.#localEndpoint(),
				bytes: effectiveSize,
				message: 'PUT target exceeds configured maxPutSize',
			})
			throw new TFTPError(TFTPErrorCode.DISK_FULL, 'File too big')
		}
		if (
			this.#options.maxPutSize !== undefined &&
			data.length > this.#options.maxPutSize
		) {
			this.#log({
				level: 'warn',
				event: 'request.denied',
				source: 'root',
				method: 'PUT',
				path,
				local: this.#localEndpoint(),
				bytes: data.length,
				message: 'Received PUT payload exceeds configured maxPutSize',
			})
			throw new TFTPError(TFTPErrorCode.DISK_FULL, 'File too big')
		}

		await Deno.writeFile(target.absolutePath, data, { create: true })
		this.#log({
			level: 'info',
			event: 'request.persisted',
			source: 'root',
			method: 'PUT',
			path,
			local: this.#localEndpoint(),
			bytes: data.length,
		})
	}

	async #serveFromRoot(path: string): Promise<TFTPResponse | undefined> {
		try {
			const resolved = await resolveReadPath(this.#rootReal!, path)
			if (!resolved.exists || !resolved.realPath) {
				return undefined
			}
			const bytes = await Deno.readFile(resolved.realPath)
			return newTFTPResponse({
				body: streamFromBytes(bytes),
				options: { tsize: bytes.length },
			}, 'root')
		} catch (error) {
			if (isTFTPError(error)) {
				if (error.code === TFTPErrorCode.FILE_NOT_FOUND) {
					return undefined
				}
				return newTFTPResponse({ error }, 'root')
			}
			throw error
		}
	}

	async #prepareWriteToRoot(
		path: string,
		request: TFTPRequest,
	): Promise<TFTPResponse | undefined> {
		if (!this.#rootReal) return undefined

		const target = await resolvePutTarget(this.#rootReal, path)
		const existing = await safeLstat(target.absolutePath)
		if (existing) {
			if (existing.isSymlink) {
				this.#log({
					level: 'warn',
					event: 'request.denied',
					source: 'root',
					method: 'PUT',
					path,
					local: this.#localEndpoint(),
					message: 'Symlinks are not allowed',
				})
				return newTFTPResponse({
					error: new TFTPError(
						TFTPErrorCode.ACCESS_VIOLATION,
						'Symlinks are not allowed',
					),
				}, 'root')
			}
			if (!existing.isFile) {
				return newTFTPResponse({
					error: new TFTPError(TFTPErrorCode.ACCESS_VIOLATION),
				}, 'root')
			}
			const realPath = await Deno.realPath(target.absolutePath)
			assertInsideRoot(this.#rootReal, realPath)
			if (!this.#options.allowOverwrite) {
				this.#log({
					level: 'warn',
					event: 'request.denied',
					source: 'root',
					method: 'PUT',
					path,
					local: this.#localEndpoint(),
					message: 'Refusing to overwrite existing file',
				})
				return newTFTPResponse({
					error: new TFTPError(TFTPErrorCode.FILE_EXISTS),
				}, 'root')
			}
		} else if (!this.#options.allowCreateFile) {
			this.#log({
				level: 'warn',
				event: 'request.denied',
				source: 'root',
				method: 'PUT',
				path,
				local: this.#localEndpoint(),
				message: 'Refusing to create missing file',
			})
			return newTFTPResponse({
				error: new TFTPError(TFTPErrorCode.ACCESS_VIOLATION),
			}, 'root')
		}

		if (
			target.parentPath !== target.nearestExistingParent &&
			!this.#options.allowCreateDir
		) {
			this.#log({
				level: 'warn',
				event: 'request.denied',
				source: 'root',
				method: 'PUT',
				path,
				local: this.#localEndpoint(),
				message: 'Refusing to create missing parent directories',
			})
			return newTFTPResponse({
				error: new TFTPError(TFTPErrorCode.ACCESS_VIOLATION),
			}, 'root')
		}

		const declaredSize = request.options.tsize
		if (
			declaredSize !== undefined && this.#options.maxPutSize !== undefined &&
			declaredSize > this.#options.maxPutSize
		) {
			this.#log({
				level: 'warn',
				event: 'request.denied',
				source: 'root',
				method: 'PUT',
				path,
				local: this.#localEndpoint(),
				bytes: declaredSize,
				message: 'PUT target exceeds configured maxPutSize',
			})
			return newTFTPResponse({
				error: new TFTPError(TFTPErrorCode.DISK_FULL, 'File too big'),
			}, 'root')
		}

		return newTFTPResponse({
			options: {
				blksize: request.options.blksize ?? 512,
				timeout: request.options.timeout ??
					Math.max(1, Math.floor(this.#options.timeout / 1000)),
				windowsize: request.options.windowsize ?? 1,
				...(declaredSize !== undefined ? { tsize: declaredSize } : {}),
			},
		}, 'root')
	}

	#localEndpoint(): TFTPEndpoint {
		return {
			address: this.host,
			port: this.port,
		}
	}

	#log(entry: ServerLogEntry): void {
		if (!this.#logger) return
		try {
			this.#logger(Object.freeze({ ...entry }))
		} catch {
			// Logging must never affect request handling.
		}
	}

	#logRequest(
		level: ServerLogLevel,
		event: string,
		source: ServerLogSource,
		request: TFTPRequest,
		remote: { address: string; port: number },
		extra: Partial<
			Omit<
				ServerLogEntry,
				| 'level'
				| 'event'
				| 'source'
				| 'method'
				| 'path'
				| 'remote'
				| 'local'
			>
		> = {},
	): void {
		this.#log({
			level,
			event,
			source,
			method: request.method,
			path: request.path,
			remote,
			local: this.#localEndpoint(),
			...extra,
		})
	}
}

function normalizeResponse(
	response: TFTPResponse | TFTPResponseInit,
): TFTPResponse {
	return response instanceof TFTPResponse
		? response
		: new TFTPResponse(response)
}

function responseLogSource(response: TFTPResponse): ServerLogSource {
	return responseLogSources.get(response) ??
		(response.error ? 'builtin_error' : 'handler')
}

function warnLevelForBuiltInError(method: TFTPMethod): ServerLogLevel {
	return method === 'GET' ? 'info' : 'warn'
}

function newTFTPResponse(
	init: TFTPResponseInit,
	source: ServerLogSource,
): TFTPResponse {
	const response = new TFTPResponse(init)
	responseLogSources.set(response, source)
	return response
}

function routeMatchesMethod(
	routeMethod: TFTPMethod | TFTPMethod[] | undefined,
	requestMethod: TFTPMethod,
): boolean {
	if (!routeMethod) return true
	return Array.isArray(routeMethod)
		? routeMethod.includes(requestMethod)
		: routeMethod === requestMethod
}

/**
 * Builds a routing handler from route definitions plus a default handler.
 *
 * Routes are tested in array order. The first route whose URL pattern matches
 * the TFTP path and whose method filter accepts the request method is used.
 */
export function route(
	routes: TFTPRoute[],
	defaultHandler: TFTPRequestHandler,
): TFTPRequestHandler {
	return (request, info) => {
		const url = new URL(`tftp://localhost/${request.path}`)
		for (const route of routes) {
			const params = route.pattern.exec(url)
			if (!params) continue
			if (!routeMatchesMethod(route.method, request.method)) continue
			return route.handler(request, params, info)
		}
		return defaultHandler(request, info)
	}
}

async function receiveFrom(
	socket: UdpConn,
	remote: UdpAddr,
	timeoutMs?: number,
): Promise<Uint8Array> {
	while (true) {
		const result = timeoutMs === undefined
			? await socket.receive()
			: await receiveWithDeadline(socket.receive(), timeoutMs)
		if (!result) {
			throw new OperationTimeoutError()
		}
		const [packet, addr] = result
		const reply = addr as UdpAddr
		if (reply.hostname === remote.hostname && reply.port === remote.port) {
			return packet
		}
		await sendPacket(
			socket,
			encodeErrorPacket(new TFTPUnknownTransferIdError()),
			reply,
		)
	}
}

async function receiveWithDeadline<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T | undefined> {
	return await new Promise<T | undefined>((resolve, reject) => {
		deadline(promise, timeoutMs).then(resolve, (error: unknown) => {
			if (isTimeoutError(error)) {
				resolve(undefined)
				return
			}
			reject(error)
		})
	})
}

async function receiveDataWindows(
	socket: UdpConn,
	remote: UdpAddr,
	options: NegotiatedTransferOptions,
	declaredSize?: number,
): Promise<{ data: Uint8Array; lastBlock: number }> {
	const chunks: Uint8Array[] = []
	let totalSize = 0
	let expectedBlock = 1
	let lastAckBlock = 0
	let receivedInWindow = 0

	while (true) {
		const packet = await receiveFrom(socket, remote, options.timeoutMs)
		if (readOpcode(packet) === TFTPOpcode.ERROR) {
			throw decodeErrorPacket(packet)
		}
		const dataPacket = decodeDataPacket(packet, options.blksize)
		if (dataPacket.block !== expectedBlock) {
			await sendPacket(socket, encodeAckPacket(lastAckBlock), remote)
			continue
		}

		chunks.push(dataPacket.data)
		totalSize += dataPacket.data.length
		if (declaredSize !== undefined && totalSize > declaredSize) {
			throw new TFTPError(
				TFTPErrorCode.NOT_DEFINED,
				'Transfer size mismatch',
			)
		}
		lastAckBlock = dataPacket.block
		expectedBlock = nextBlock(expectedBlock)
		receivedInWindow += 1

		const done = dataPacket.data.length < options.blksize
		if (done || receivedInWindow >= options.windowsize) {
			if (!done) {
				await sendPacket(socket, encodeAckPacket(lastAckBlock), remote)
			}
			receivedInWindow = 0
		}

		if (done) {
			if (declaredSize !== undefined && totalSize !== declaredSize) {
				throw new TFTPError(
					TFTPErrorCode.NOT_DEFINED,
					'Transfer size mismatch',
				)
			}
			const data = concatChunks(chunks)
			return { data, lastBlock: lastAckBlock }
		}
	}
}

async function resendFinalAckIfNeeded(
	socket: UdpConn,
	remote: UdpAddr,
	lastBlock: number,
	options: NegotiatedTransferOptions,
): Promise<void> {
	while (true) {
		const reply = await receiveWithDeadline(
			socket.receive(),
			options.timeoutMs,
		)
		if (!reply) {
			return
		}

		const [packet, addr] = reply
		const replyAddr = addr as UdpAddr
		if (
			replyAddr.hostname !== remote.hostname ||
			replyAddr.port !== remote.port
		) {
			await sendPacket(
				socket,
				encodeErrorPacket(
					new TFTPUnknownTransferIdError(),
				),
				replyAddr,
			)
			continue
		}

		if (readOpcode(packet) === TFTPOpcode.ERROR) {
			return
		}

		const dataPacket = decodeDataPacket(packet, options.blksize)
		if (dataPacket.block === lastBlock) {
			await sendPacket(socket, encodeAckPacket(lastBlock), remote)
			continue
		}
		return
	}
}

async function sendDataWindows(
	socket: UdpConn,
	remote: UdpAddr,
	blocks: Uint8Array[],
	options: NegotiatedTransferOptions,
	retries: number,
): Promise<void> {
	const blockNumbers: number[] = []
	let block = 1
	for (let index = 0; index < blocks.length; index++) {
		blockNumbers.push(block)
		block = nextBlock(block)
	}

	let index = 0
	while (index < blocks.length) {
		const end = Math.min(index + options.windowsize, blocks.length)
		const window = [] as Array<{ block: number; packet: Uint8Array }>
		for (let cursor = index; cursor < end; cursor++) {
			window.push({
				block: blockNumbers[cursor],
				packet: encodeDataPacket(blockNumbers[cursor], blocks[cursor]),
			})
		}

		const resendWindow = async () => {
			for (const entry of window) {
				await sendPacket(socket, entry.packet, remote)
			}
		}

		await resendWindow()
		let acked: number
		try {
			acked = await retry(async () => {
				const ackIndex = await receiveWindowAck(
					socket,
					remote,
					window,
					options.timeoutMs,
				)
				if (ackIndex === undefined) {
					await resendWindow()
					throw new OperationTimeoutError()
				}
				return ackIndex
			}, {
				maxAttempts: retries + 1,
				jitter: 0,
				minTimeout: 1,
				maxTimeout: 1,
				isRetriable: (error: unknown) =>
					isTransferTimeoutError(error) || isUnknownTransferIdError(error),
			})
		} catch (error) {
			throw unwrapRetryError(error)
		}
		index += acked + 1
	}
}

async function receiveWindowAck(
	socket: UdpConn,
	remote: UdpAddr,
	window: Array<{ block: number }>,
	timeoutMs: number,
): Promise<number | undefined> {
	while (true) {
		const reply = await receiveWithDeadline(socket.receive(), timeoutMs)
		if (!reply) {
			return undefined
		}

		const [packet, addr] = reply
		const replyAddr = addr as UdpAddr
		if (
			replyAddr.hostname !== remote.hostname ||
			replyAddr.port !== remote.port
		) {
			await sendPacket(
				socket,
				encodeErrorPacket(
					new TFTPUnknownTransferIdError(),
				),
				replyAddr,
			)
			continue
		}

		if (readOpcode(packet) === TFTPOpcode.ERROR) {
			throw decodeErrorPacket(packet)
		}

		const ack = decodeAckPacket(packet)
		const ackIndex = window.findIndex((entry) => entry.block === ack.block)
		if (ackIndex === -1) {
			continue
		}
		return ackIndex
	}
}

function negotiatedServerOptions(
	request: TFTPRequest,
	response: TFTPResponse,
	defaultTimeoutMs: number,
): NegotiatedTransferOptions {
	return {
		blksize: response.options?.blksize ?? request.options.blksize ?? 512,
		timeoutMs: (response.options?.timeout ?? request.options.timeout ??
			Math.max(1, Math.floor(defaultTimeoutMs / 1000))) * 1000,
		windowsize: response.options?.windowsize ?? request.options.windowsize ??
			1,
		tsize: response.options?.tsize ?? request.options.tsize,
	}
}

async function sendPacket(
	socket: UdpConn,
	packet: Uint8Array,
	remote: UdpAddr,
): Promise<void> {
	await socket.send(packet, toSendAddr(remote))
}

function readOpcode(packet: Uint8Array): number {
	return new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
		.getUint16(0)
}

function splitIntoBlocks(data: Uint8Array, blockSize: number): Uint8Array[] {
	if (data.length === 0) {
		return [new Uint8Array()]
	}

	const blocks: Uint8Array[] = []
	for (let offset = 0; offset < data.length; offset += blockSize) {
		blocks.push(data.slice(offset, offset + blockSize))
	}
	if (data.length % blockSize === 0) {
		blocks.push(new Uint8Array())
	}
	return blocks
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
	const out = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		out.set(chunk, offset)
		offset += chunk.length
	}
	return out
}

function nextBlock(block: number): number {
	return block === 0xffff ? 0 : block + 1
}

function shouldSendOack(request: TFTPRequest): boolean {
	return Object.keys(request.options).length > 0 ||
		Object.keys(request.extensions).length > 0
}

function buildOackOptions(
	request: TFTPRequest,
	response: TFTPResponse,
	options: NegotiatedTransferOptions,
): Partial<TFTPOptions> {
	const oack: Partial<TFTPOptions> = {}
	if (request.options.blksize !== undefined) {
		oack.blksize = options.blksize
	}
	if (request.options.timeout !== undefined) {
		oack.timeout = Math.max(1, Math.floor(options.timeoutMs / 1000))
	}
	if (request.options.windowsize !== undefined) {
		oack.windowsize = options.windowsize
	}
	if (request.options.tsize !== undefined) {
		const tsize = response.options?.tsize ?? request.options.tsize
		if (!(request.method === 'GET' && request.mode === 'netascii')) {
			oack.tsize = tsize
		}
	}
	return oack
}

function isTFTPError(
	value: unknown,
): value is TFTPError {
	return value instanceof TFTPError
}

function isTimeoutError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'TimeoutError'
}

function isTransferTimeoutError(error: unknown): boolean {
	return isTimeoutError(error) || error instanceof OperationTimeoutError
}

function isUnknownTransferIdError(error: unknown): boolean {
	return error instanceof TFTPUnknownTransferIdError
}

function unwrapRetryError(error: unknown): unknown {
	if (error instanceof Error && 'cause' in error) {
		const cause = (error as Error & { cause?: unknown }).cause
		if (cause !== undefined) {
			return cause
		}
	}
	return error
}

function toSendAddr(addr: UdpAddr): Deno.NetAddr {
	return {
		transport: 'udp',
		hostname: addr.hostname,
		port: addr.port,
	}
}

async function safeLstat(path: string): Promise<Deno.FileInfo | undefined> {
	try {
		return await Deno.lstat(path)
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) {
			return undefined
		}
		throw error
	}
}
