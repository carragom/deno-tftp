import { deadline, retry } from '@std/async'

import {
	decodeAckPacket,
	decodeDataPacket,
	decodeErrorPacket,
	decodeOptionsAckPacket,
	encodeAckPacket,
	encodeDataPacket,
	encodeErrorPacket,
	encodeRequestPacket,
	OperationTimeoutError,
	TFTPError,
	TFTPErrorCode,
	TFTPIllegalOperationError,
	TFTPOpcode,
	TFTPUnknownTransferIdError,
} from './common.ts'
import type {
	ClientGetOptions,
	ClientOptions,
	ClientPutOptions,
	TFTPRequest,
	TFTPResponse,
} from './common.ts'
import {
	createClientRequest,
	decodeNetascii,
	encodeNetascii,
	normalizeClientOptions,
	readBodyToBytes,
	streamFromBytes,
} from './utils.ts'
import type { NormalizedClientOptions } from './utils.ts'

type UdpAddr = Deno.NetAddr & { transport: 'udp' }

interface NegotiatedTransferOptions {
	blksize: number
	timeoutMs: number
	windowsize: number
	tsize?: number
}

export class Client {
	#options: NormalizedClientOptions

	constructor(options: ClientOptions = {}) {
		this.#options = normalizeClientOptions(options)
	}

	get host(): string {
		return this.#options.host
	}

	get port(): number {
		return this.#options.port
	}

	async request(request: TFTPRequest): Promise<TFTPResponse> {
		const socket = Deno.listenDatagram({
			transport: 'udp',
			hostname: '0.0.0.0',
			port: 0,
		})

		try {
			const requestPacket = encodeRequestPacket(request)
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

	async get(
		path: string,
		options: ClientGetOptions = {},
	): Promise<TFTPResponse> {
		return await this.request(
			createClientRequest('GET', path, {
				mode: options.mode,
				options: options.options,
				extensions: options.extensions,
			}, this.#options),
		)
	}

	async put(
		path: string,
		body: ReadableStream<Uint8Array>,
		options: ClientPutOptions = {},
	): Promise<TFTPResponse> {
		const bytes = await readBodyToBytes(body)
		const payload = options.mode === 'netascii'
			? encodeNetascii(bytes)
			: bytes
		return await this.request(
			createClientRequest('PUT', path, {
				mode: options.mode,
				options: {
					...(options.options ?? {}),
					...(options.size !== undefined
						? { tsize: options.size }
						: { tsize: payload.length }),
				},
				extensions: options.extensions,
				body: streamFromBytes(payload),
			}, this.#options),
		)
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
