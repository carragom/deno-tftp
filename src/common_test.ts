import { assertEquals, assertThrows } from '@std/assert'

import {
	decodeAckPacket,
	decodeDataPacket,
	decodeErrorPacket,
	decodeOptionsAckPacket,
	decodeRequestPacket,
	encodeAckPacket,
	encodeDataPacket,
	encodeErrorPacket,
	encodeOptionsAckPacket,
	TFTPError,
	TFTPErrorCode,
	TFTPMaxBlockSize,
	TFTPMaxTimeoutSeconds,
	TFTPMinBlockSize,
	TFTPMinTimeoutSeconds,
	TFTPRequest,
	TFTPResponse,
} from './common.ts'

Deno.test('request class normalizes defaults and freezes maps', () => {
	const request = new TFTPRequest({
		method: 'GET',
		path: 'boot/file.bin',
	})

	assertEquals(request.mode, 'octet')
	assertEquals(request.options, {})
	assertEquals(request.extensions, {})
	assertThrows(() => {
		;(request.options as { blksize?: number }).blksize = 1
	}, TypeError)
	assertThrows(() => {
		;(request.extensions as Record<string, string>).token = 'abc'
	}, TypeError)
})

Deno.test('request with clones overrides', () => {
	const request = new TFTPRequest({
		method: 'GET',
		path: 'boot/file.bin',
		options: { blksize: 1468 },
	})

	const next = request.with({ path: 'next/file.bin', mode: 'netascii' })
	assertEquals(next.path, 'next/file.bin')
	assertEquals(next.mode, 'netascii')
	assertEquals(next.options.blksize, 1468)
	assertEquals(request.path, 'boot/file.bin')
})

Deno.test('response class computes ok and freezes maps', () => {
	const response = new TFTPResponse({
		options: { blksize: 1468 },
		extensions: { token: 'abc' },
	})

	assertEquals(response.ok, true)
	assertThrows(() => {
		;(response.options as { blksize?: number }).blksize = 1
	}, TypeError)
	assertThrows(() => {
		;(response.extensions as Record<string, string>).token = 'def'
	}, TypeError)

	const errorResponse = new TFTPResponse({
		error: decodeErrorPacket(
			encodeErrorPacket(new TFTPError(TFTPErrorCode.FILE_NOT_FOUND)),
		),
	})
	assertEquals(errorResponse.ok, false)
	assertEquals(errorResponse.error?.code, TFTPErrorCode.FILE_NOT_FOUND)
})

Deno.test('request packet round-trips', () => {
	const request = new TFTPRequest({
		method: 'GET',
		path: 'boot/file.bin',
		options: { blksize: 1468, timeout: 3, tsize: 0, windowsize: 4 },
		extensions: { token: 'abc' },
	})

	const decoded = decodeRequestPacket(TFTPRequest.encode(request))
	assertEquals(decoded.method, 'GET')
	assertEquals(decoded.path, 'boot/file.bin')
	assertEquals(decoded.mode, 'octet')
	assertEquals(decoded.options.blksize, 1468)
	assertEquals(decoded.extensions.token, 'abc')
})

Deno.test('request packet rejects oversize message', () => {
	const request = new TFTPRequest({
		method: 'GET',
		path: 'x',
		extensions: { giant: 'a'.repeat(600) },
	})
	assertThrows(() => TFTPRequest.encode(request))
})

Deno.test('data packet round-trips', () => {
	const data = new Uint8Array([1, 2, 3])
	const decoded = decodeDataPacket(encodeDataPacket(7, data))
	assertEquals(decoded.block, 7)
	assertEquals(Array.from(decoded.data), [1, 2, 3])
})

Deno.test('ack packet round-trips', () => {
	assertEquals(decodeAckPacket(encodeAckPacket(9)).block, 9)
})

Deno.test('error packet round-trips', () => {
	const decoded = decodeErrorPacket(
		encodeErrorPacket(new TFTPError(TFTPErrorCode.ACCESS_VIOLATION, 'nope')),
	)
	assertEquals(decoded.code, TFTPErrorCode.ACCESS_VIOLATION)
	assertEquals(decoded.message, 'nope')
})

Deno.test('oack packet round-trips', () => {
	const decoded = decodeOptionsAckPacket(
		encodeOptionsAckPacket({ blksize: 1468, windowsize: 4 }, {
			token: 'abc',
		}),
	)
	assertEquals(decoded.options.blksize, 1468)
	assertEquals(decoded.extensions.token, 'abc')
})

Deno.test('request decode rejects invalid mode', () => {
	const packet = new Uint8Array([
		0,
		1,
		...new TextEncoder().encode('foo'),
		0,
		...new TextEncoder().encode('mail'),
		0,
	])
	assertThrows(() => decodeRequestPacket(packet))
})

Deno.test('request decode rejects invalid block size options', () => {
	assertThrows(() =>
		decodeRequestPacket(
			TFTPRequest.encode(
				new TFTPRequest({
					method: 'GET',
					path: 'foo',
					options: { blksize: TFTPMinBlockSize - 1 },
				}),
			),
		)
	)
	assertThrows(() =>
		decodeRequestPacket(
			TFTPRequest.encode(
				new TFTPRequest({
					method: 'GET',
					path: 'foo',
					options: { blksize: TFTPMaxBlockSize + 1 },
				}),
			),
		)
	)
})

Deno.test('request decode rejects invalid timeout options', () => {
	assertThrows(() =>
		decodeRequestPacket(
			TFTPRequest.encode(
				new TFTPRequest({
					method: 'GET',
					path: 'foo',
					options: { timeout: TFTPMinTimeoutSeconds - 1 },
				}),
			),
		)
	)
	assertThrows(() =>
		decodeRequestPacket(
			TFTPRequest.encode(
				new TFTPRequest({
					method: 'GET',
					path: 'foo',
					options: { timeout: TFTPMaxTimeoutSeconds + 1 },
				}),
			),
		)
	)
})

Deno.test('request decode rejects non-zero GET tsize', () => {
	assertThrows(() =>
		decodeRequestPacket(
			TFTPRequest.encode(
				new TFTPRequest({
					method: 'GET',
					path: 'foo',
					options: { tsize: 1 },
				}),
			),
		)
	)
})
