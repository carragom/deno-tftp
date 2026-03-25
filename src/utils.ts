import {
	dirname,
	fromFileUrl,
	join,
	normalize,
	relative,
	resolve,
	SEPARATOR,
} from '@std/path'

import {
	createRequest,
	createTFTPError,
	TFTPDefaultBlockSize,
	TFTPDefaultPort,
	TFTPDefaultRetries,
	TFTPDefaultTimeout,
	TFTPDefaultTransferMode,
	TFTPDefaultWindowSize,
	TFTPErrorCode,
	TFTPMaxBlockSize,
	TFTPMaxWindowSize,
	TFTPMinBlockSize,
	TFTPMinWindowSize,
} from './common.ts'
import type {
	TFTPMethod,
	TFTPMode,
	TFTPOptions,
	TFTPRequest,
	TFTPResponse,
} from './common.ts'

export interface NormalizedClientOptions {
	host: string
	port: number
	blockSize: number
	windowSize: number
	timeout: number
	retries: number
}

export interface NormalizedServerOptions extends NormalizedClientOptions {
	root?: string
	denyGET: boolean
	denyPUT: boolean
	allowOverwrite: boolean
	allowCreateFile: boolean
	allowCreateDir: boolean
	maxPutSize?: number
}

export interface TFTPUri {
	host: string
	port?: number
	path: string
	mode?: TFTPMode
}

export interface ResolvedPath {
	absolutePath: string
	realPath?: string
	relativePath: string
	exists: boolean
}

export interface ResolvedPutTarget {
	absolutePath: string
	parentPath: string
	nearestExistingParent: string
	relativePath: string
}

const textEncoder = new TextEncoder()

export function normalizeClientOptions(options: {
	host?: string
	port?: number
	blockSize?: number
	windowSize?: number
	timeout?: number
	retries?: number
} = {}): NormalizedClientOptions {
	return {
		host: options.host ?? '127.0.0.1',
		port: normalizePort(options.port),
		blockSize: normalizeBlockSize(options.blockSize),
		windowSize: normalizeWindowSize(options.windowSize),
		timeout: normalizePositiveInteger(options.timeout, TFTPDefaultTimeout),
		retries: normalizePositiveInteger(options.retries, TFTPDefaultRetries),
	}
}

export function normalizeServerOptions(options: {
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
} = {}): NormalizedServerOptions {
	return {
		host: options.host ?? '127.0.0.1',
		port: normalizeBindPort(options.port),
		blockSize: normalizeBlockSize(options.blockSize),
		windowSize: normalizeWindowSize(options.windowSize),
		timeout: normalizePositiveInteger(options.timeout, TFTPDefaultTimeout),
		retries: normalizePositiveInteger(options.retries, TFTPDefaultRetries),
		root: options.root,
		denyGET: options.denyGET ?? false,
		denyPUT: options.denyPUT ?? false,
		allowOverwrite: options.allowOverwrite ?? false,
		allowCreateFile: options.allowCreateFile ?? true,
		allowCreateDir: options.allowCreateDir ?? false,
		maxPutSize: options.maxPutSize,
	}
}

export function mergeRequestOptions(
	defaults: TFTPOptions,
	overrides: Partial<TFTPOptions> | undefined,
): TFTPOptions {
	return {
		...defaults,
		...(overrides ?? {}),
	}
}

export function createClientRequest(
	method: TFTPMethod,
	path: string,
	init: {
		mode?: TFTPMode
		options?: Partial<TFTPOptions>
		extensions?: Record<string, string>
		body?: ReadableStream<Uint8Array>
	},
	clientOptions: NormalizedClientOptions,
): TFTPRequest {
	return createRequest(method, normalizeTFTPPath(path), {
		mode: init.mode ?? TFTPDefaultTransferMode,
		options: mergeRequestOptions({
			blksize: clientOptions.blockSize,
			timeout: Math.max(1, Math.floor(clientOptions.timeout / 1000)),
			windowsize: clientOptions.windowSize,
			...(method === 'GET' ? { tsize: 0 } : {}),
		}, init.options),
		extensions: init.extensions,
		body: init.body,
	})
}

export function normalizeTFTPPath(path: string): string {
	if (path.includes('\0')) {
		throw new Error('TFTP paths cannot contain NUL bytes')
	}

	const normalized = normalize(path.replaceAll('\\', '/'))
	const withoutLeading = normalized.replace(/^\/+/, '')
	if (!withoutLeading || withoutLeading === '.') {
		throw new Error('TFTP paths cannot be empty')
	}

	if (withoutLeading.split('/').some((segment: string) => segment === '..')) {
		throw new Error('TFTP paths cannot escape the transfer root')
	}

	return withoutLeading
}

export function parseTFTPUri(uri: string): TFTPUri {
	const url = new URL(uri)
	if (url.protocol !== 'tftp:') {
		throw new Error(`Unsupported protocol: ${url.protocol}`)
	}

	const [pathname, ...params] = url.pathname.split(';')
	let mode: TFTPMode | undefined
	for (const param of params) {
		const [key, value] = param.split('=')
		if (key === 'mode' && (value === 'octet' || value === 'netascii')) {
			mode = value
		}
	}

	return {
		host: url.hostname,
		port: url.port ? Number(url.port) : undefined,
		path: normalizeTFTPPath(decodeURIComponent(pathname)),
		mode,
	}
}

export function parseInteropServer(
	value: string,
): { host: string; port: number } {
	const parts = value.split(':')
	if (parts.length === 1) {
		return { host: parts[0], port: TFTPDefaultPort }
	}
	const port = Number(parts.pop())
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid TEST_INTEROP_SERVER port: ${value}`)
	}
	return { host: parts.join(':'), port }
}

export async function canonicalizeRoot(root: string): Promise<string> {
	const resolved = resolve(root)
	const stat = await Deno.lstat(resolved)
	if (stat.isSymlink) {
		throw new Error('The root cannot be a symlink')
	}
	if (!stat.isDirectory) {
		throw new Error('The root must be a directory')
	}
	return await Deno.realPath(resolved)
}

export async function resolveReadPath(
	root: string,
	requestPath: string,
): Promise<ResolvedPath> {
	const relativePath = normalizeTFTPPath(requestPath)
	const absolutePath = join(root, relativePath)
	const stat = await maybeLstat(absolutePath)
	if (!stat) {
		return { absolutePath, relativePath, exists: false }
	}
	if (stat.isSymlink) {
		throw createTFTPError(
			TFTPErrorCode.ACCESS_VIOLATION,
			'Symlinks are not allowed',
		)
	}
	const realPath = await Deno.realPath(absolutePath)
	assertInsideRoot(root, realPath)
	const realStat = await Deno.lstat(realPath)
	if (realStat.isSymlink || !realStat.isFile) {
		throw createTFTPError(TFTPErrorCode.FILE_NOT_FOUND)
	}
	return { absolutePath, realPath, relativePath, exists: true }
}

export async function resolvePutTarget(
	root: string,
	requestPath: string,
): Promise<ResolvedPutTarget> {
	const relativePath = normalizeTFTPPath(requestPath)
	const absolutePath = join(root, relativePath)
	const existing = await maybeLstat(absolutePath)
	if (existing) {
		if (existing.isSymlink) {
			throw createTFTPError(
				TFTPErrorCode.ACCESS_VIOLATION,
				'Symlinks are not allowed',
			)
		}
		const realPath = await Deno.realPath(absolutePath)
		assertInsideRoot(root, realPath)
		return {
			absolutePath,
			parentPath: dirname(absolutePath),
			nearestExistingParent: dirname(realPath),
			relativePath,
		}
	}

	let current = dirname(absolutePath)
	while (true) {
		const stat = await maybeLstat(current)
		if (stat) {
			if (stat.isSymlink) {
				throw createTFTPError(
					TFTPErrorCode.ACCESS_VIOLATION,
					'Symlinks are not allowed',
				)
			}
			const realPath = await Deno.realPath(current)
			assertInsideRoot(root, realPath)
			return {
				absolutePath,
				parentPath: dirname(absolutePath),
				nearestExistingParent: realPath,
				relativePath,
			}
		}
		const next = dirname(current)
		if (next === current) {
			break
		}
		current = next
	}

	throw createTFTPError(TFTPErrorCode.ACCESS_VIOLATION)
}

export function assertInsideRoot(root: string, candidate: string): void {
	const rel = relative(root, candidate)
	if (rel === '' || rel === '.') return
	if (
		rel === '..' || rel.startsWith(`..${SEPARATOR}`) ||
		rel.includes(`..${SEPARATOR}`)
	) {
		throw createTFTPError(TFTPErrorCode.ACCESS_VIOLATION)
	}
}

export function stripNegotiatedOptions(
	options: Partial<TFTPOptions>,
): Partial<TFTPOptions> {
	const result: Partial<TFTPOptions> = {}
	for (
		const key of [
			'blksize',
			'timeout',
			'tsize',
			'windowsize',
			'rollover',
		] as const
	) {
		const value = options[key]
		if (value !== undefined) {
			result[key] = value
		}
	}
	return result
}

export async function readStreamFully(
	stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	const reader = stream.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			chunks.push(value)
			total += value.length
		}
	} finally {
		reader.releaseLock()
	}
	const result = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		result.set(chunk, offset)
		offset += chunk.length
	}
	return result
}

export function streamFromBytes(data: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(data)
			controller.close()
		},
	})
}

export async function readBodyToBytes(
	body?: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	if (!body) return new Uint8Array()
	return await readStreamFully(body)
}

export function textBody(text: string): ReadableStream<Uint8Array> {
	return streamFromBytes(textEncoder.encode(text))
}

export function responseToBytes(response: TFTPResponse): Promise<Uint8Array> {
	return readBodyToBytes(response.body)
}

export function encodeNetascii(data: Uint8Array): Uint8Array {
	const out: number[] = []
	for (const byte of data) {
		if (byte === 0x0a) {
			out.push(0x0d, 0x0a)
		} else if (byte === 0x0d) {
			out.push(0x0d, 0x00)
		} else {
			out.push(byte)
		}
	}
	return Uint8Array.from(out)
}

export function decodeNetascii(data: Uint8Array): Uint8Array {
	const out: number[] = []
	let pendingCr = false
	for (const byte of data) {
		if (!pendingCr) {
			if (byte === 0x0d) {
				pendingCr = true
			} else {
				out.push(byte)
			}
			continue
		}

		if (byte === 0x0a) {
			out.push(0x0a)
			pendingCr = false
			continue
		}
		if (byte === 0x00) {
			out.push(0x0d)
			pendingCr = false
			continue
		}

		out.push(0x0d)
		pendingCr = byte === 0x0d
		if (!pendingCr) {
			out.push(byte)
		}
	}
	if (pendingCr) {
		out.push(0x0d)
	}
	return Uint8Array.from(out)
}

export function rootDirectoryOfModuleUrl(url: string): string {
	return dirname(fromFileUrl(url))
}

async function maybeLstat(path: string): Promise<Deno.FileInfo | undefined> {
	try {
		return await Deno.lstat(path)
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) {
			return undefined
		}
		throw error
	}
}

function normalizePort(port: number | undefined): number {
	const value = port ?? TFTPDefaultPort
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		throw new RangeError(`Invalid port: ${value}`)
	}
	return value
}

function normalizeBindPort(port: number | undefined): number {
	const value = port ?? TFTPDefaultPort
	if (!Number.isInteger(value) || value < 0 || value > 65535) {
		throw new RangeError(`Invalid port: ${value}`)
	}
	return value
}

function normalizeBlockSize(blockSize: number | undefined): number {
	const value = blockSize ?? TFTPDefaultBlockSize
	if (
		!Number.isInteger(value) || value < TFTPMinBlockSize ||
		value > TFTPMaxBlockSize
	) {
		throw new RangeError(`Invalid block size: ${value}`)
	}
	return value
}

function normalizeWindowSize(windowSize: number | undefined): number {
	const value = windowSize ?? TFTPDefaultWindowSize
	if (
		!Number.isInteger(value) || value < TFTPMinWindowSize ||
		value > TFTPMaxWindowSize
	) {
		throw new RangeError(`Invalid window size: ${value}`)
	}
	return value
}

function normalizePositiveInteger(
	value: number | undefined,
	fallback: number,
): number {
	const normalized = value ?? fallback
	if (!Number.isInteger(normalized) || normalized < 1) {
		throw new RangeError(`Invalid positive integer: ${normalized}`)
	}
	return normalized
}
