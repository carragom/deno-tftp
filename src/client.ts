import { deadline, retry } from '@std/async'

import type {
	TFTPMethod,
	TFTPMode,
	TFTPOptions,
	TFTPResponse,
} from './common.ts'
import {
	decodeAckPacket,
	decodeDataPacket,
	decodeErrorPacket,
	decodeOptionsAckPacket,
	encodeAckPacket,
	encodeDataPacket,
	encodeErrorPacket,
	OperationTimeoutError,
	TFTPError,
	TFTPErrorCode,
	TFTPIllegalOperationError,
	TFTPOpcode,
	TFTPRequest,
	TFTPUnknownTransferIdError,
} from './common.ts'
import type { NormalizedClientOptions } from './utils.ts'
import {
	decodeNetascii,
	encodeNetascii,
	normalizeClientOptions,
	normalizeTFTPPath,
	readBodyToBytes,
	streamFromBytes,
} from './utils.ts'

type UdpAddr = Deno.NetAddr & { transport: 'udp' }

interface NegotiatedTransferOptions {
	blksize: number
	timeoutMs: number
	windowsize: number
	tsize?: number
}

/**
 * Client-wide defaults for advanced and convenience request APIs.
 *
 * These values set the remote endpoint and the default TFTP option negotiation
 * behavior for requests created by this client instance.
 */
export interface ClientOptions {
	/** Remote TFTP server hostname or IP address. Defaults to `127.0.0.1`. */
	host?: string
	/** Remote TFTP server port. Defaults to `69`. */
	port?: number
	/**
	 * Default requested block size for transfers created by this client.
	 *
	 * Per-call request options override this value.
	 */
	blockSize?: number
	/**
	 * Default requested windowsize for transfers created by this client.
	 *
	 * Per-call request options override this value.
	 */
	windowSize?: number
	/**
	 * Default requested transfer timeout in milliseconds.
	 *
	 * The client requests whole-second timeout values on the wire and uses this
	 * value for local receive deadlines.
	 */
	timeout?: number
	/**
	 * Number of retransmission attempts for timed-out operations.
	 *
	 * This controls local retry behavior, not the on-wire TFTP `timeout` option.
	 */
	retries?: number
}

/**
 * Additional options for GET requests.
 *
 * All properties are optional. Missing values fall back to the client instance
 * defaults and then to the built-in constructor defaults used for the client.
 */
export interface ClientGetOptions {
	/** Transfer mode. Defaults to `octet`. */
	mode?: TFTPMode
	/**
	 * Requested standard RFC option negotiation values.
	 *
	 * These values override the instance defaults for this request only.
	 */
	options?: Partial<TFTPOptions>
	/**
	 * Additional non-standard extension pairs to include in the request.
	 *
	 * Standard TFTP option keys should go in `options` instead.
	 */
	extensions?: Record<string, string>
}

/**
 * Additional options for PUT convenience requests.
 *
 * These options are used by {@link Client.put} and extend the GET request
 * options with optional explicit transfer size metadata.
 */
export interface ClientPutOptions extends ClientGetOptions {
	/**
	 * Declared transfer size in octets.
	 *
	 * When omitted, {@link Client.put} uses the encoded payload size.
	 */
	size?: number
}

/**
 * Additional options for advanced PUT requests made through {@link Client.request}.
 */
export interface ClientRequestPutOptions extends ClientGetOptions {
	/** Request body to upload. */
	body: ReadableStream<Uint8Array>
	/**
	 * Declared transfer size in octets.
	 *
	 * When omitted, the encoded payload size is used.
	 */
	size?: number
}

/**
 * Stateful TFTP client bound to one remote endpoint.
 *
 * A client instance owns the remote host and port and also carries default TFTP
 * option negotiation values used by its request-building APIs. Use {@link get}
 * and {@link put} for the common cases. Use the overloaded {@link request}
 * method when you want one entrypoint that can build either a GET or PUT
 * request while still keeping the API shaped around TFTP concepts.
 */
export class Client {
	#options: NormalizedClientOptions

	/**
	 * Creates a client bound to one remote TFTP server.
	 *
	 * The provided options become instance defaults. Per-call request options
	 * override them. Any missing values fall back to the library defaults.
	 */
	constructor(options: ClientOptions = {}) {
		this.#options = normalizeClientOptions(options)
	}

	/** Configured remote hostname for this client instance. */
	get host(): string {
		return this.#options.host
	}

	/** Configured remote port for this client instance. */
	get port(): number {
		return this.#options.port
	}

	/**
	 * Builds and executes an advanced GET request.
	 *
	 * Use this overload when you want one method that can express GET-specific
	 * TFTP behavior without constructing a request object yourself. The effective
	 * request options are computed from:
	 *
	 * 1. per-call GET options
	 * 2. client instance defaults
	 * 3. built-in client defaults
	 *
	 * The client always normalizes the path into the library's canonical TFTP
	 * path form before sending the request. For GET, the client requests
	 * `tsize=0` by default so the server can report the transfer size in its
	 * OACK when supported by RFC 2349 negotiation.
	 *
	 * ```ts
	 * const response = await client.request('boot/kernel.img', 'GET')
	 * ```
	 *
	 * ```ts
	 * const response = await client.request('boot/kernel.img', 'GET', {
	 *   mode: 'netascii',
	 *   options: { blksize: 1428, windowsize: 4 },
	 * })
	 * ```
	 */
	request(
		path: string,
		method: 'GET',
		options?: ClientGetOptions,
	): Promise<TFTPResponse>
	/**
	 * Builds and executes an advanced PUT request using only a body stream.
	 *
	 * This is the shortest advanced PUT form. The client uses the configured
	 * instance defaults for request option negotiation and derives the transfer
	 * size from the encoded payload.
	 *
	 * ```ts
	 * const file = await Deno.open('firmware.bin', { read: true })
	 * await client.request('uploads/firmware.bin', 'PUT', file.readable)
	 * file.close()
	 * ```
	 */
	request(
		path: string,
		method: 'PUT',
		body: ReadableStream<Uint8Array>,
	): Promise<TFTPResponse>
	/**
	 * Builds and executes an advanced PUT request with explicit PUT options.
	 *
	 * Use this overload when you need to control transfer mode, extensions, or a
	 * declared transfer size in addition to the required body stream. Per-call
	 * options override the client instance defaults for this request only.
	 *
	 * Architecturally, this method is the advanced public client API. It is
	 * responsible for overload discrimination, path normalization, option
	 * precedence, and construction of the effective internal {@link TFTPRequest}.
	 * The private `#sendRequest()` method then handles the transport exchange.
	 *
	 * ```ts
	 * await client.request('uploads/firmware.bin', 'PUT', {
	 *   body: file.readable,
	 *   mode: 'octet',
	 *   options: { blksize: 1468, windowsize: 4 },
	 * })
	 * ```
	 */
	request(
		path: string,
		method: 'PUT',
		options: ClientRequestPutOptions,
	): Promise<TFTPResponse>
	request(
		path: string,
		method: TFTPMethod,
		options?:
			| ClientGetOptions
			| ClientRequestPutOptions
			| ReadableStream<Uint8Array>,
	): Promise<TFTPResponse> {
		const normalizedPath = normalizeTFTPPath(path)
		if (method === 'GET') {
			if (options instanceof ReadableStream) {
				throw new TypeError('GET requests do not accept a request body')
			}
			const getOptions = options ?? {}
			return this.#sendRequest(
				new TFTPRequest({
					method,
					path: normalizedPath,
					mode: getOptions.mode,
					options: {
						blksize: this.#options.blockSize,
						timeout: Math.max(
							1,
							Math.floor(this.#options.timeout / 1000),
						),
						windowsize: this.#options.windowSize,
						tsize: 0,
						...(getOptions.options ?? {}),
					},
					extensions: getOptions.extensions,
				}),
			)
		}

		const putOptions: ClientRequestPutOptions | undefined =
			options instanceof ReadableStream
				? { body: options }
				: options && 'body' in options
				? options
				: undefined
		if (!putOptions?.body) {
			throw new TypeError('PUT requests require a request body')
		}

		return this.#requestPut(normalizedPath, putOptions)
	}

	async #requestPut(
		path: string,
		options: ClientRequestPutOptions,
	): Promise<TFTPResponse> {
		const bytes = await readBodyToBytes(options.body)
		const payload = options.mode === 'netascii'
			? encodeNetascii(bytes)
			: bytes
		return await this.#sendRequest(
			new TFTPRequest({
				method: 'PUT',
				path,
				mode: options.mode,
				options: {
					blksize: this.#options.blockSize,
					timeout: Math.max(1, Math.floor(this.#options.timeout / 1000)),
					windowsize: this.#options.windowSize,
					...(options.options ?? {}),
					...(options.size !== undefined
						? { tsize: options.size }
						: { tsize: payload.length }),
				},
				extensions: options.extensions,
				body: streamFromBytes(payload),
			}),
		)
	}

	async #sendRequest(request: TFTPRequest): Promise<TFTPResponse> {
		const socket = Deno.listenDatagram({
			transport: 'udp',
			hostname: '0.0.0.0',
			port: 0,
		})

		try {
			const requestPacket = TFTPRequest.encode(request)
			const serverAddr = {
				transport: 'udp' as const,
				hostname: this.#options.host,
				port: this.#options.port,
			}
			await socket.send(requestPacket, serverAddr)

			const initial = await receivePacket(
				socket,
				this.#options.timeout,
				this.#options.retries,
				async () => {
					await socket.send(requestPacket, serverAddr)
				},
			)

			if (readOpcode(initial.packet) === TFTPOpcode.ERROR) {
				throw decodeErrorPacket(initial.packet)
			}

			const remote = initial.addr
			const remoteAddr = {
				transport: 'udp' as const,
				hostname: remote.hostname,
				port: remote.port,
			}

			if (request.method === 'GET') {
				return await this.#handleGet(
					socket,
					request,
					initial.packet,
					remoteAddr,
				)
			}

			return await this.#handlePut(
				socket,
				request,
				initial.packet,
				remoteAddr,
			)
		} finally {
			socket.close()
		}
	}

	/**
	 * Downloads a file from the configured remote endpoint.
	 *
	 * This is the preferred convenience API for reads. It delegates to the
	 * advanced {@link request} overloads after applying GET-specific defaults.
	 */
	async get(
		path: string,
		options: ClientGetOptions = {},
	): Promise<TFTPResponse> {
		return await this.request(path, 'GET', options)
	}

	/**
	 * Uploads a stream to the configured remote endpoint.
	 *
	 * This is the preferred convenience API for writes. It delegates to the
	 * advanced PUT request overload after providing the body explicitly.
	 */
	async put(
		path: string,
		body: ReadableStream<Uint8Array>,
		options: ClientPutOptions = {},
	): Promise<TFTPResponse> {
		return await this.request(path, 'PUT', { ...options, body })
	}

	async #handleGet(
		socket: Deno.DatagramConn,
		request: TFTPRequest,
		firstPacket: Uint8Array,
		remoteAddr: Deno.NetAddr,
	): Promise<TFTPResponse> {
		const negotiated = readNegotiatedOptions(request, firstPacket)
		let packet = firstPacket
		let lastAck = 0

		if (readOpcode(firstPacket) === TFTPOpcode.OACK) {
			const ack0 = encodeAckPacket(0)
			await socket.send(ack0, remoteAddr)
			packet = (await receivePacket(
				socket,
				negotiated.timeoutMs,
				this.#options.retries,
				async () => {
					await socket.send(ack0, remoteAddr)
				},
				remoteAddr,
				ack0,
			)).packet
		}

		const { data, lastBlock } = await receiveDataWindows(
			socket,
			packet,
			remoteAddr,
			negotiated,
			this.#options.retries,
			lastAck,
		)
		lastAck = lastBlock
		void lastAck

		return {
			body: streamFromBytes(
				request.mode === 'netascii' ? decodeNetascii(data) : data,
			),
			options: {
				blksize: negotiated.blksize,
				timeout: Math.max(1, Math.floor(negotiated.timeoutMs / 1000)),
				windowsize: negotiated.windowsize,
				...(negotiated.tsize !== undefined
					? { tsize: negotiated.tsize }
					: {}),
			},
		}
	}

	async #handlePut(
		socket: Deno.DatagramConn,
		request: TFTPRequest,
		firstPacket: Uint8Array,
		remoteAddr: Deno.NetAddr,
	): Promise<TFTPResponse> {
		const negotiated = writeNegotiatedOptions(request, firstPacket)
		const data = await readBodyToBytes(request.body)
		const blocks = splitBlocks(data, negotiated.blksize ?? 512)

		await sendDataWindows(
			socket,
			blocks,
			remoteAddr,
			negotiated,
			this.#options.retries,
		)

		return {
			options: {
				blksize: negotiated.blksize,
				timeout: Math.max(1, Math.floor(negotiated.timeoutMs / 1000)),
				windowsize: negotiated.windowsize,
				tsize: data.length,
			},
		}
	}
}

function readNegotiatedOptions(
	request: TFTPRequest,
	packet: Uint8Array,
): NegotiatedTransferOptions {
	if (readOpcode(packet) !== TFTPOpcode.OACK) {
		return {
			blksize: 512,
			timeoutMs: (request.options.timeout ?? 1) * 1000,
			windowsize: 1,
			tsize: request.options.tsize,
		}
	}
	return readOack(request, packet)
}

function writeNegotiatedOptions(
	request: TFTPRequest,
	packet: Uint8Array,
): NegotiatedTransferOptions {
	const opcode = readOpcode(packet)
	if (opcode === TFTPOpcode.ACK) {
		const ack = decodeAckPacket(packet)
		if (ack.block !== 0) {
			throw new TFTPIllegalOperationError('Expected ack block 0')
		}
		return {
			blksize: 512,
			timeoutMs: (request.options.timeout ?? 1) * 1000,
			windowsize: 1,
			tsize: request.options.tsize,
		}
	}
	if (opcode !== TFTPOpcode.OACK) {
		throw new TFTPIllegalOperationError('Expected ACK or OACK packet')
	}
	return readOack(request, packet)
}

function readOack(
	request: TFTPRequest,
	packet: Uint8Array,
): NegotiatedTransferOptions {
	const decoded = decodeOptionsAckPacket(packet)
	const blksize = decoded.options.blksize ?? 512
	const timeout = decoded.options.timeout ?? request.options.timeout ?? 1
	const windowsize = decoded.options.windowsize ?? 1
	if (
		request.options.blksize !== undefined && blksize > request.options.blksize
	) {
		throw new TFTPError(
			TFTPErrorCode.REQUEST_DENIED,
			'Invalid block size in OACK',
		)
	}
	if (
		request.options.timeout !== undefined &&
		timeout !== request.options.timeout
	) {
		throw new TFTPError(
			TFTPErrorCode.REQUEST_DENIED,
			'Invalid timeout in OACK',
		)
	}
	if (
		request.options.windowsize !== undefined &&
		windowsize > request.options.windowsize
	) {
		throw new TFTPError(
			TFTPErrorCode.REQUEST_DENIED,
			'Invalid window size in OACK',
		)
	}
	return {
		blksize,
		timeoutMs: timeout * 1000,
		windowsize,
		tsize: decoded.options.tsize ?? request.options.tsize,
	}
}

function readOpcode(packet: Uint8Array): number {
	return new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
		.getUint16(0)
}

function nextBlock(block: number): number {
	return block === 0xffff ? 0 : block + 1
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

function splitBlocks(data: Uint8Array, blockSize: number): Uint8Array[] {
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

async function receivePacket(
	socket: Deno.DatagramConn,
	timeoutMs: number,
	retries: number,
	resend: () => Promise<void>,
	expectedRemote?: Deno.NetAddr,
	onUnexpectedRemote?: Uint8Array,
): Promise<{ packet: Uint8Array; addr: UdpAddr }> {
	try {
		return await retry(async () => {
			const received = await receiveWithDeadline(socket.receive(), timeoutMs)
			if (!received) {
				await resend()
				throw new OperationTimeoutError()
			}

			const [packet, addr] = received
			const remote = addr as UdpAddr
			if (
				expectedRemote &&
				(remote.hostname !== expectedRemote.hostname ||
					remote.port !== expectedRemote.port)
			) {
				if (onUnexpectedRemote) {
					await socket.send(onUnexpectedRemote, {
						transport: 'udp',
						hostname: remote.hostname,
						port: remote.port,
					})
				}
				throw new TFTPUnknownTransferIdError()
			}
			return { packet, addr: remote }
		}, {
			maxAttempts: retries + 1,
			jitter: 0,
			minTimeout: 1,
			maxTimeout: 1,
			isRetriable: (error: unknown) =>
				isOperationTimeoutError(error) || isUnknownTransferIdError(error),
		})
	} catch (error) {
		throw unwrapRetryError(error)
	}
}

async function receiveDataWindows(
	socket: Deno.DatagramConn,
	firstPacket: Uint8Array,
	remoteAddr: Deno.NetAddr,
	options: NegotiatedTransferOptions,
	retries: number,
	initialAckBlock: number,
): Promise<{ data: Uint8Array; lastBlock: number }> {
	const chunks: Uint8Array[] = []
	let expectedBlock = nextBlock(initialAckBlock)
	let packet: Uint8Array | undefined = firstPacket
	let lastAckBlock = initialAckBlock
	let inWindow = 0

	while (true) {
		if (!packet) {
			const ack = encodeAckPacket(lastAckBlock)
			packet = (await receivePacket(
				socket,
				options.timeoutMs,
				retries,
				async () => {
					await socket.send(ack, remoteAddr)
				},
				remoteAddr,
				encodeErrorPacket(
					new TFTPUnknownTransferIdError(),
				),
			)).packet
		}

		if (readOpcode(packet) === TFTPOpcode.ERROR) {
			throw decodeErrorPacket(packet)
		}

		const dataPacket = decodeDataPacket(packet, options.blksize)
		if (dataPacket.block !== expectedBlock) {
			const ack = encodeAckPacket(lastAckBlock)
			await socket.send(ack, remoteAddr)
			packet = undefined
			continue
		}

		chunks.push(dataPacket.data)
		lastAckBlock = dataPacket.block
		expectedBlock = nextBlock(expectedBlock)
		inWindow += 1

		const finalBlock = dataPacket.data.length < options.blksize
		if (finalBlock || inWindow >= options.windowsize) {
			const ack = encodeAckPacket(lastAckBlock)
			await socket.send(ack, remoteAddr)
			inWindow = 0
			if (finalBlock) {
				return { data: concatChunks(chunks), lastBlock: lastAckBlock }
			}
		}

		packet = undefined
	}
}

async function sendDataWindows(
	socket: Deno.DatagramConn,
	blocks: Uint8Array[],
	remoteAddr: Deno.NetAddr,
	options: NegotiatedTransferOptions,
	retries: number,
): Promise<void> {
	const blockNumbers: number[] = []
	let block = 1
	for (let index = 0; index < blocks.length; index++) {
		blockNumbers.push(block)
		block = nextBlock(block)
	}

	let nextIndex = 0
	while (nextIndex < blocks.length) {
		const lastIndex = Math.min(
			nextIndex + options.windowsize - 1,
			blocks.length - 1,
		)
		const packets = [] as Array<{ block: number; packet: Uint8Array }>
		for (let index = nextIndex; index <= lastIndex; index++) {
			packets.push({
				block: blockNumbers[index],
				packet: encodeDataPacket(blockNumbers[index], blocks[index]),
			})
		}

		const sendWindow = async () => {
			for (const entry of packets) {
				await socket.send(entry.packet, remoteAddr)
			}
		}

		await sendWindow()
		let attempts = 0
		while (true) {
			const ackIndex = await receiveWindowAck(
				socket,
				remoteAddr,
				packets,
				options.timeoutMs,
			)
			if (ackIndex === undefined) {
				if (attempts >= retries) {
					throw new OperationTimeoutError()
				}
				attempts += 1
				await sendWindow()
				continue
			}
			nextIndex += ackIndex + 1
			break
		}
	}
}

async function receiveWindowAck(
	socket: Deno.DatagramConn,
	remoteAddr: Deno.NetAddr,
	packets: Array<{ block: number }>,
	timeoutMs: number,
): Promise<number | undefined> {
	while (true) {
		const reply = await receiveWithDeadline(socket.receive(), timeoutMs)
		if (!reply) {
			return undefined
		}

		const [packet, addr] = reply
		const remote = addr as UdpAddr
		if (
			remote.hostname !== remoteAddr.hostname ||
			remote.port !== remoteAddr.port
		) {
			await socket.send(
				encodeErrorPacket(
					new TFTPUnknownTransferIdError(),
				),
				{
					transport: 'udp',
					hostname: remote.hostname,
					port: remote.port,
				},
			)
			continue
		}

		if (readOpcode(packet) === TFTPOpcode.ERROR) {
			throw decodeErrorPacket(packet)
		}

		const ack = decodeAckPacket(packet)
		const ackIndex = findWindowAckIndex(packets, ack.block)
		if (ackIndex === -1) {
			continue
		}
		return ackIndex
	}
}

function findWindowAckIndex(
	packets: Array<{ block: number }>,
	ackBlock: number,
): number {
	return packets.findIndex((entry) => entry.block === ackBlock)
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

function isTimeoutError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'TimeoutError'
}

function isOperationTimeoutError(error: unknown): boolean {
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
