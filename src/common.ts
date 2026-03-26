export type TFTPMethod = 'GET' | 'PUT'
export type TFTPMode = 'octet' | 'netascii'

export interface TFTPOptions {
	blksize?: number
	timeout?: number
	tsize?: number
	windowsize?: number
	rollover?: number
}

export class TFTPError extends Error {
	readonly code: number

	constructor(code: number, message?: string) {
		super(
			message ??
				TFTPErrorMessage[code as keyof typeof TFTPErrorMessage] ??
				TFTPErrorMessage[TFTPErrorCode.NOT_DEFINED],
		)
		this.code = code
		this.name = TFTPErrorName[code as keyof typeof TFTPErrorName] ??
			'TFTPError'
		Object.setPrototypeOf(this, new.target.prototype)
	}
}

export class OperationTimeoutError extends Error {
	constructor(message = 'Timed out') {
		super(message)
		this.name = 'OperationTimeoutError'
		Object.setPrototypeOf(this, new.target.prototype)
	}
}

/** Remote TFTP ERROR packet decoded from the wire. */
export class TFTPRemoteError extends TFTPError {
	constructor(code: number, message?: string) {
		super(code, message)
		this.name = 'TFTPRemoteError'
		Object.setPrototypeOf(this, new.target.prototype)
	}
}

export class TFTPUnknownTransferIdError extends TFTPError {
	constructor(message?: string) {
		super(TFTPErrorCode.UNKNOWN_TRANSFER_ID, message)
	}
}

export class TFTPIllegalOperationError extends TFTPError {
	constructor(message?: string) {
		super(TFTPErrorCode.ILLEGAL_OPERATION, message)
	}
}

export interface TFTPRequestInit {
	method: TFTPMethod
	path: string
	mode?: TFTPMode
	options?: Partial<TFTPOptions>
	extensions?: Record<string, string>
	body?: ReadableStream<Uint8Array>
}

export class TFTPRequest {
	readonly method: TFTPMethod
	readonly path: string
	readonly mode: TFTPMode
	readonly options: Readonly<TFTPOptions>
	readonly extensions: Readonly<Record<string, string>>
	readonly body?: ReadableStream<Uint8Array>

	constructor(init: TFTPRequestInit) {
		this.method = init.method
		this.path = init.path
		this.mode = init.mode ?? TFTPDefaultTransferMode
		this.options = Object.freeze({ ...(init.options ?? {}) })
		this.extensions = Object.freeze({ ...(init.extensions ?? {}) })
		this.body = init.body
	}

	static encode(request: TFTPRequest): Uint8Array {
		const opcode = request.method === 'GET' ? TFTPOpcode.RRQ : TFTPOpcode.WRQ
		const pairs: Array<[string, string]> = []

		for (
			const key of Object.keys(request.options) as Array<keyof TFTPOptions>
		) {
			const value = request.options[key]
			if (value === undefined) continue
			pairs.push([key, String(value)])
		}

		for (const [key, value] of Object.entries(request.extensions)) {
			if (TFTPKnownExtensionKeys.has(key as keyof TFTPOptions)) continue
			pairs.push([key, value])
		}

		const buffer = encodeZeroTerminatedFields([
			request.path,
			request.mode,
			...pairs.flat(),
		], opcode)

		if (buffer.length > TFTPRequestPacketLimit) {
			throw new TFTPError(
				TFTPErrorCode.NOT_DEFINED,
				'Request bigger than 512 bytes',
			)
		}

		return buffer
	}

	with(init: Partial<TFTPRequestInit>): TFTPRequest {
		return new TFTPRequest({
			method: init.method ?? this.method,
			path: init.path ?? this.path,
			mode: init.mode ?? this.mode,
			options: init.options ?? this.options,
			extensions: init.extensions ?? this.extensions,
			body: init.body ?? this.body,
		})
	}
}

export interface TFTPResponseInit {
	body?: ReadableStream<Uint8Array>
	options?: Partial<TFTPOptions>
	extensions?: Record<string, string>
	error?: TFTPError
}

/**
 * TFTP response returned by client operations and used by server handlers.
 *
 * A response is successful when it does not carry a remote TFTP ERROR result.
 */
export class TFTPResponse {
	readonly body?: ReadableStream<Uint8Array>
	readonly options?: Readonly<Partial<TFTPOptions>>
	readonly extensions?: Readonly<Record<string, string>>
	readonly error?: TFTPError

	constructor(init: TFTPResponseInit = {}) {
		this.body = init.body
		this.options = init.options
			? Object.freeze({ ...init.options })
			: undefined
		this.extensions = init.extensions
			? Object.freeze({ ...init.extensions })
			: undefined
		this.error = init.error
	}

	/** Whether the response does not carry a remote TFTP ERROR packet. */
	get ok(): boolean {
		return this.error === undefined
	}
}

export interface TFTPEndpoint {
	address: string
	port: number
}

export interface TFTPServeHandlerInfo {
	remote: Readonly<TFTPEndpoint>
	local: Readonly<TFTPEndpoint>
}

export type TFTPHandler = (
	request: TFTPRequest,
	info: TFTPServeHandlerInfo,
) => TFTPResponse | TFTPResponseInit | Promise<TFTPResponse | TFTPResponseInit>

export interface TFTPRoute {
	pattern: URLPattern
	method?: TFTPMethod | TFTPMethod[]
	handler: TFTPHandler
}

export interface ServerOptions {
	host?: string
	port?: number
	root?: string
	denyGET?: boolean
	denyPUT?: boolean
	allowOverwrite?: boolean
	allowCreateFile?: boolean
	allowCreateDir?: boolean
	maxPutSize?: number
	blockSize?: number
	windowSize?: number
	timeout?: number
	retries?: number
}

export const TFTPErrorCode = {
	NOT_DEFINED: 0,
	FILE_NOT_FOUND: 1,
	ACCESS_VIOLATION: 2,
	DISK_FULL: 3,
	ILLEGAL_OPERATION: 4,
	UNKNOWN_TRANSFER_ID: 5,
	FILE_EXISTS: 6,
	NO_SUCH_USER: 7,
	REQUEST_DENIED: 8,
} as const

export const TFTPErrorName = {
	[TFTPErrorCode.FILE_NOT_FOUND]: 'ENOENT',
	[TFTPErrorCode.ACCESS_VIOLATION]: 'EACCESS',
	[TFTPErrorCode.DISK_FULL]: 'ENOSPC',
	[TFTPErrorCode.ILLEGAL_OPERATION]: 'EBADOP',
	[TFTPErrorCode.UNKNOWN_TRANSFER_ID]: 'ETID',
	[TFTPErrorCode.FILE_EXISTS]: 'EEXIST',
	[TFTPErrorCode.NO_SUCH_USER]: 'ENOUSER',
	[TFTPErrorCode.REQUEST_DENIED]: 'EDENY',
} as const

export const TFTPErrorMessage = {
	[TFTPErrorCode.NOT_DEFINED]: 'Not defined',
	[TFTPErrorCode.FILE_NOT_FOUND]: 'File not found',
	[TFTPErrorCode.ACCESS_VIOLATION]: 'Access violation',
	[TFTPErrorCode.DISK_FULL]: 'Disk full or allocation exceeded',
	[TFTPErrorCode.ILLEGAL_OPERATION]: 'Illegal TFTP operation',
	[TFTPErrorCode.UNKNOWN_TRANSFER_ID]: 'Unknown transfer ID',
	[TFTPErrorCode.FILE_EXISTS]: 'File already exists',
	[TFTPErrorCode.NO_SUCH_USER]: 'No such user',
	[TFTPErrorCode.REQUEST_DENIED]: 'The request has been denied',
} as const

export const TFTPModeValues = ['octet', 'netascii'] as const

export const TFTPDefaultBlockSize = 1468
export const TFTPDefaultWindowSize = 4
export const TFTPDefaultTimeout = 3000
export const TFTPDefaultRetries = 3
export const TFTPDefaultPort = 69
export const TFTPDefaultTransferMode: TFTPMode = 'octet'
export const TFTPRequestPacketLimit = 512
export const TFTPMinBlockSize = 8
export const TFTPMaxBlockSize = 65464
export const TFTPMinWindowSize = 1
export const TFTPMaxWindowSize = 65535
export const TFTPMinTimeoutSeconds = 1
export const TFTPMaxTimeoutSeconds = 255

export const TFTPKnownExtensionKeys: ReadonlySet<keyof TFTPOptions> = new Set<
	keyof TFTPOptions
>([
	'blksize',
	'timeout',
	'tsize',
	'windowsize',
	'rollover',
])

export const TFTPOpcode = {
	RRQ: 1,
	WRQ: 2,
	DATA: 3,
	ACK: 4,
	ERROR: 5,
	OACK: 6,
} as const

export interface ParsedRequestPacket {
	method: TFTPMethod
	path: string
	mode: TFTPMode
	options: TFTPOptions
	extensions: Record<string, string>
}

export interface ParsedDataPacket {
	block: number
	data: Uint8Array
}

export interface ParsedAckPacket {
	block: number
}

export interface ParsedOptionsAckPacket {
	options: Partial<TFTPOptions>
	extensions: Record<string, string>
}

export function decodeRequestPacket(packet: Uint8Array): ParsedRequestPacket {
	if (packet.length < 4) {
		throw new TFTPIllegalOperationError('Malformed TFTP message')
	}

	const view = new DataView(
		packet.buffer,
		packet.byteOffset,
		packet.byteLength,
	)
	const opcode = view.getUint16(0)
	if (opcode !== TFTPOpcode.RRQ && opcode !== TFTPOpcode.WRQ) {
		throw new TFTPIllegalOperationError()
	}

	const fields = decodeZeroTerminatedFields(packet, 2)
	if (fields.length < 2 || fields.length % 2 !== 0) {
		throw new TFTPIllegalOperationError('Malformed TFTP message')
	}

	const [rawPath, rawMode, ...pairs] = fields
	const mode = rawMode.toLowerCase() as TFTPMode
	if (!TFTPModeValues.includes(mode)) {
		throw new TFTPIllegalOperationError('Invalid transfer mode')
	}

	const options: TFTPOptions = {}
	const extensions: Record<string, string> = {}
	for (let i = 0; i < pairs.length; i += 2) {
		const key = pairs[i].toLowerCase()
		const value = pairs[i + 1]
		if (key in options || key in extensions) {
			throw new TFTPError(TFTPErrorCode.REQUEST_DENIED, 'Duplicate option')
		}
		if (TFTPKnownExtensionKeys.has(key as keyof TFTPOptions)) {
			options[key as keyof TFTPOptions] = parseKnownOption(
				key as keyof TFTPOptions,
				value,
				opcode === TFTPOpcode.RRQ,
			)
		} else {
			extensions[key] = value
		}
	}

	return {
		method: opcode === TFTPOpcode.RRQ ? 'GET' : 'PUT',
		path: rawPath,
		mode,
		options,
		extensions,
	}
}

export function encodeDataPacket(block: number, data: Uint8Array): Uint8Array {
	const packet = new Uint8Array(4 + data.length)
	const view = new DataView(packet.buffer)
	view.setUint16(0, TFTPOpcode.DATA)
	view.setUint16(2, normalizeBlock(block))
	packet.set(data, 4)
	return packet
}

export function decodeDataPacket(
	packet: Uint8Array,
	maxBlockSize = TFTPMaxBlockSize,
): ParsedDataPacket {
	const view = new DataView(
		packet.buffer,
		packet.byteOffset,
		packet.byteLength,
	)
	if (packet.length < 4 || view.getUint16(0) !== TFTPOpcode.DATA) {
		throw new TFTPIllegalOperationError('Malformed TFTP message')
	}
	const data = packet.slice(4)
	if (data.length > maxBlockSize) {
		throw new TFTPIllegalOperationError('Malformed TFTP message')
	}
	return {
		block: view.getUint16(2),
		data,
	}
}

export function encodeAckPacket(block: number): Uint8Array {
	const packet = new Uint8Array(4)
	const view = new DataView(packet.buffer)
	view.setUint16(0, TFTPOpcode.ACK)
	view.setUint16(2, normalizeBlock(block))
	return packet
}

export function decodeAckPacket(packet: Uint8Array): ParsedAckPacket {
	const view = new DataView(
		packet.buffer,
		packet.byteOffset,
		packet.byteLength,
	)
	if (packet.length !== 4 || view.getUint16(0) !== TFTPOpcode.ACK) {
		throw new TFTPIllegalOperationError('Malformed TFTP message')
	}
	return { block: view.getUint16(2) }
}

export function encodeErrorPacket(error: TFTPError): Uint8Array {
	return encodeZeroTerminatedFields(
		[error.message],
		TFTPOpcode.ERROR,
		error.code,
	)
}

export function decodeErrorPacket(packet: Uint8Array): TFTPRemoteError {
	const view = new DataView(
		packet.buffer,
		packet.byteOffset,
		packet.byteLength,
	)
	if (packet.length < 4 || view.getUint16(0) !== TFTPOpcode.ERROR) {
		throw new TFTPIllegalOperationError('Malformed TFTP message')
	}
	const fields = decodeZeroTerminatedFields(packet, 4)
	const code = view.getUint16(2)
	return new TFTPRemoteError(
		code,
		fields[0] ?? TFTPErrorMessage[TFTPErrorCode.NOT_DEFINED],
	)
}

export function encodeOptionsAckPacket(
	options: Partial<TFTPOptions> = {},
	extensions: Record<string, string> = {},
): Uint8Array {
	const fields: string[] = []
	for (const key of Object.keys(options) as Array<keyof TFTPOptions>) {
		const value = options[key]
		if (value === undefined) continue
		fields.push(key, String(value))
	}
	for (const [key, value] of Object.entries(extensions)) {
		fields.push(key, value)
	}
	return encodeZeroTerminatedFields(fields, TFTPOpcode.OACK)
}

export function decodeOptionsAckPacket(
	packet: Uint8Array,
): ParsedOptionsAckPacket {
	const view = new DataView(
		packet.buffer,
		packet.byteOffset,
		packet.byteLength,
	)
	if (packet.length < 2 || view.getUint16(0) !== TFTPOpcode.OACK) {
		throw new TFTPIllegalOperationError('Malformed TFTP message')
	}

	const fields = decodeZeroTerminatedFields(packet, 2)
	if (fields.length % 2 !== 0) {
		throw new TFTPIllegalOperationError('Malformed TFTP message')
	}

	const options: Partial<TFTPOptions> = {}
	const extensions: Record<string, string> = {}
	for (let i = 0; i < fields.length; i += 2) {
		const key = fields[i].toLowerCase()
		const value = fields[i + 1]
		if (TFTPKnownExtensionKeys.has(key as keyof TFTPOptions)) {
			options[key as keyof TFTPOptions] = parseKnownOption(
				key as keyof TFTPOptions,
				value,
				false,
			)
		} else {
			extensions[key] = value
		}
	}

	return { options, extensions }
}

export function methodMatches(
	routeMethod: TFTPMethod | TFTPMethod[] | undefined,
	requestMethod: TFTPMethod,
): boolean {
	if (!routeMethod) return true
	return Array.isArray(routeMethod)
		? routeMethod.includes(requestMethod)
		: routeMethod === requestMethod
}

function parseKnownOption(
	key: keyof TFTPOptions,
	rawValue: string,
	isReadRequest: boolean,
): number {
	if (!/^\d+$/.test(rawValue)) {
		throw new TFTPError(TFTPErrorCode.REQUEST_DENIED, 'Invalid option value')
	}

	const value = Number(rawValue)
	switch (key) {
		case 'blksize':
			if (value < TFTPMinBlockSize || value > TFTPMaxBlockSize) {
				throw new TFTPError(
					TFTPErrorCode.REQUEST_DENIED,
					'Invalid block size',
				)
			}
			return value
		case 'timeout':
			if (value < TFTPMinTimeoutSeconds || value > TFTPMaxTimeoutSeconds) {
				throw new TFTPError(TFTPErrorCode.REQUEST_DENIED, 'Invalid timeout')
			}
			return value
		case 'tsize':
			if (value < 0 || (isReadRequest && value !== 0)) {
				throw new TFTPError(
					TFTPErrorCode.REQUEST_DENIED,
					'Invalid transfer size',
				)
			}
			return value
		case 'windowsize':
			if (value < TFTPMinWindowSize || value > TFTPMaxWindowSize) {
				throw new TFTPError(
					TFTPErrorCode.REQUEST_DENIED,
					'Invalid window size',
				)
			}
			return value
		case 'rollover':
			if (value !== 0 && value !== 1) {
				throw new TFTPError(
					TFTPErrorCode.REQUEST_DENIED,
					'Invalid rollover',
				)
			}
			return value
	}
}

function encodeZeroTerminatedFields(
	fields: string[],
	opcode: number,
	extraShort?: number,
): Uint8Array {
	const encodedFields = fields.map((field) => new TextEncoder().encode(field))
	const total = 2 + (extraShort === undefined ? 0 : 2) +
		encodedFields.reduce((sum, field) => sum + field.length + 1, 0)
	const buffer = new Uint8Array(total)
	const view = new DataView(buffer.buffer)
	view.setUint16(0, opcode)
	let offset = 2
	if (extraShort !== undefined) {
		view.setUint16(offset, extraShort)
		offset += 2
	}
	for (const field of encodedFields) {
		buffer.set(field, offset)
		offset += field.length + 1
	}
	return buffer
}

function decodeZeroTerminatedFields(
	packet: Uint8Array,
	offset: number,
): string[] {
	const fields: string[] = []
	let start = offset
	for (let index = offset; index < packet.length; index++) {
		if (packet[index] !== 0) continue
		fields.push(new TextDecoder().decode(packet.slice(start, index)))
		start = index + 1
	}
	if (start !== packet.length) {
		throw new TFTPIllegalOperationError('Malformed TFTP message')
	}
	return fields
}

function normalizeBlock(block: number): number {
	if (!Number.isInteger(block) || block < 0 || block > 0xffff) {
		throw new RangeError(`Invalid TFTP block number: ${block}`)
	}
	return block
}
