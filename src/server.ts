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
	methodMatches,
	OperationTimeoutError,
	TFTPError,
	TFTPErrorCode,
	TFTPIllegalOperationError,
	TFTPOpcode,
	TFTPRequest,
	TFTPUnknownTransferIdError,
} from './common.ts'
import type {
	ParsedRequestPacket,
	ServerOptions,
	TFTPHandler,
	TFTPOptions,
	TFTPRequestInit,
	TFTPResponse,
	TFTPRoute,
	TFTPServeHandlerInfo,
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

export class Server {
	#options: NormalizedServerOptions
	#handler?: TFTPHandler
	#defaultHandler?: TFTPHandler
	#rootReal?: string
	#socket?: UdpConn
	#loop?: Promise<void>
	#listening = false
	#sessions = new Set<Promise<void>>()

	constructor(
		handler?: TFTPHandler,
		options: ServerOptions = {},
		defaultHandler?: TFTPHandler,
	) {
		this.#options = normalizeServerOptions(options)
		this.#handler = handler
		this.#defaultHandler = defaultHandler
	}

	get host(): string {
		if (this.#socket) {
			return this.#socket.addr.hostname
		}
		return this.#options.host
	}

	get port(): number {
		if (this.#socket) {
			return this.#socket.addr.port
		}
		return this.#options.port
	}

	get root(): string | undefined {
		return this.#options.root
	}

	get denyGET(): boolean {
		return this.#options.denyGET
	}

	get denyPUT(): boolean {
		return this.#options.denyPUT
	}

	get allowOverwrite(): boolean {
		return this.#options.allowOverwrite
	}

	get allowCreateFile(): boolean {
		return this.#options.allowCreateFile
	}

	get allowCreateDir(): boolean {
		return this.#options.allowCreateDir
	}

	get maxPutSize(): number | undefined {
		return this.#options.maxPutSize
	}

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
		this.#loop = this.#acceptLoop()
	}

	async close(): Promise<void> {
		if (!this.#listening) return
		this.#listening = false
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

	async request(
		request: TFTPRequestInit,
		remote: { address: string; port: number },
	): Promise<TFTPResponse> {
		return await this.#prepareResponse(
			new TFTPRequest(request),
			remote,
			false,
		)
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
			return {
				error: new TFTPError(
					TFTPErrorCode.ACCESS_VIOLATION,
					'Cannot GET files',
				),
			}
		}
		if (request.method === 'PUT' && this.#options.denyPUT) {
			return {
				error: new TFTPError(
					TFTPErrorCode.ACCESS_VIOLATION,
					'Cannot PUT files',
				),
			}
		}

		if (this.#rootReal) {
			const fileResponse = request.method === 'GET'
				? await this.#serveFromRoot(normalizedPath)
				: await this.#prepareWriteToRoot(normalizedPath, normalizedRequest)
			if (fileResponse) {
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
			const response = await this.#handler(
				normalizedRequest,
				info,
			)
			if (
				response.error || response.body || response.options ||
				response.extensions
			) {
				return response
			}
		}

		if (this.#defaultHandler) {
			return await this.#defaultHandler(
				normalizedRequest,
				info,
			)
		}

		return {
			error: new TFTPError(
				normalizedRequest.method === 'GET'
					? TFTPErrorCode.FILE_NOT_FOUND
					: TFTPErrorCode.ACCESS_VIOLATION,
			),
		}
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
			const opcode = packet.length >= 2 ? readOpcode(packet) : -1
			if (opcode !== TFTPOpcode.RRQ && opcode !== TFTPOpcode.WRQ) {
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
		const response = await this.#prepareResponse(request, {
			address: remote.hostname,
			port: remote.port,
		}, true)

		try {
			if (response.error) {
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
		} catch (error) {
			if (isTFTPError(error)) {
				await sendPacket(socket, encodeErrorPacket(error), remote)
				return
			}
			if (error instanceof OperationTimeoutError) {
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
				throw new TFTPError(TFTPErrorCode.FILE_EXISTS)
			}
		} else if (!this.#options.allowCreateFile) {
			throw new TFTPError(TFTPErrorCode.ACCESS_VIOLATION)
		}

		if (target.parentPath !== target.nearestExistingParent) {
			if (!this.#options.allowCreateDir) {
				throw new TFTPError(TFTPErrorCode.ACCESS_VIOLATION)
			}
			await Deno.mkdir(target.parentPath, { recursive: true })
		}

		const effectiveSize = declaredSize ?? data.length
		if (
			this.#options.maxPutSize !== undefined &&
			effectiveSize > this.#options.maxPutSize
		) {
			throw new TFTPError(TFTPErrorCode.DISK_FULL, 'File too big')
		}
		if (
			this.#options.maxPutSize !== undefined &&
			data.length > this.#options.maxPutSize
		) {
			throw new TFTPError(TFTPErrorCode.DISK_FULL, 'File too big')
		}

		await Deno.writeFile(target.absolutePath, data, { create: true })
	}

	async #serveFromRoot(path: string): Promise<TFTPResponse | undefined> {
		try {
			const resolved = await resolveReadPath(this.#rootReal!, path)
			if (!resolved.exists || !resolved.realPath) {
				return undefined
			}
			const bytes = await Deno.readFile(resolved.realPath)
			return {
				body: streamFromBytes(bytes),
				options: { tsize: bytes.length },
			}
		} catch (error) {
			if (isTFTPError(error)) {
				if (error.code === TFTPErrorCode.FILE_NOT_FOUND) {
					return undefined
				}
				return { error }
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
				return {
					error: new TFTPError(
						TFTPErrorCode.ACCESS_VIOLATION,
						'Symlinks are not allowed',
					),
				}
			}
			if (!existing.isFile) {
				return { error: new TFTPError(TFTPErrorCode.ACCESS_VIOLATION) }
			}
			const realPath = await Deno.realPath(target.absolutePath)
			assertInsideRoot(this.#rootReal, realPath)
			if (!this.#options.allowOverwrite) {
				return { error: new TFTPError(TFTPErrorCode.FILE_EXISTS) }
			}
		} else if (!this.#options.allowCreateFile) {
			return { error: new TFTPError(TFTPErrorCode.ACCESS_VIOLATION) }
		}

		if (
			target.parentPath !== target.nearestExistingParent &&
			!this.#options.allowCreateDir
		) {
			return { error: new TFTPError(TFTPErrorCode.ACCESS_VIOLATION) }
		}

		const declaredSize = request.options.tsize
		if (
			declaredSize !== undefined && this.#options.maxPutSize !== undefined &&
			declaredSize > this.#options.maxPutSize
		) {
			return {
				error: new TFTPError(TFTPErrorCode.DISK_FULL, 'File too big'),
			}
		}

		return {
			options: {
				blksize: request.options.blksize ?? 512,
				timeout: request.options.timeout ??
					Math.max(1, Math.floor(this.#options.timeout / 1000)),
				windowsize: request.options.windowsize ?? 1,
				...(declaredSize !== undefined ? { tsize: declaredSize } : {}),
			},
		}
	}
}

export function route(
	routes: TFTPRoute[],
	defaultHandler: TFTPHandler,
): TFTPHandler {
	return (request, info) => {
		const url = new URL(`tftp://localhost/${request.path}`)
		for (const route of routes) {
			const match = route.pattern.exec(url)
			if (!match) continue
			if (!methodMatches(route.method, request.method)) continue
			return route.handler(
				request,
				info ?? {
					remote: { address: '127.0.0.1', port: 0 },
					local: { address: '127.0.0.1', port: 0 },
				},
			)
		}
		return defaultHandler(
			request,
			info ?? {
				remote: { address: '127.0.0.1', port: 0 },
				local: { address: '127.0.0.1', port: 0 },
			},
		)
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
