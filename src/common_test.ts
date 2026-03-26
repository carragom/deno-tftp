import { assertEquals, assertThrows } from '@std/assert'

import {
	createRequest,
	decodeAckPacket,
	decodeDataPacket,
	decodeErrorPacket,
	decodeOptionsAckPacket,
	decodeRequestPacket,
	encodeAckPacket,
	encodeDataPacket,
	encodeErrorPacket,
	encodeOptionsAckPacket,
	encodeRequestPacket,
	TFTPError,
	TFTPErrorCode,
	TFTPMaxBlockSize,
	TFTPMaxTimeoutSeconds,
	TFTPMinBlockSize,
	TFTPMinTimeoutSeconds,
} from './common.ts'

Deno.test('request packet round-trips', () => {
	const request = createRequest('GET', 'boot/file.bin', {
		options: { blksize: 1468, timeout: 3, tsize: 0, windowsize: 4 },
		extensions: { token: 'abc' },
	})

	const decoded = decodeRequestPacket(encodeRequestPacket(request))
	assertEquals(decoded.method, 'GET')
	assertEquals(decoded.path, 'boot/file.bin')
	assertEquals(decoded.mode, 'octet')
	assertEquals(decoded.options.blksize, 1468)
	assertEquals(decoded.extensions.token, 'abc')
})

Deno.test('request packet rejects oversize message', () => {
	const request = createRequest('GET', 'x', {
		extensions: { giant: 'a'.repeat(600) },
	})
	assertThrows(() => encodeRequestPacket(request))
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
			encodeRequestPacket(createRequest('GET', 'foo', {
				options: { blksize: TFTPMinBlockSize - 1 },
			})),
		)
	)
	assertThrows(() =>
		decodeRequestPacket(
			encodeRequestPacket(createRequest('GET', 'foo', {
				options: { blksize: TFTPMaxBlockSize + 1 },
			})),
		)
	)
})

Deno.test('request decode rejects invalid timeout options', () => {
	assertThrows(() =>
		decodeRequestPacket(
			encodeRequestPacket(createRequest('GET', 'foo', {
				options: { timeout: TFTPMinTimeoutSeconds - 1 },
			})),
		)
	)
	assertThrows(() =>
		decodeRequestPacket(
			encodeRequestPacket(createRequest('GET', 'foo', {
				options: { timeout: TFTPMaxTimeoutSeconds + 1 },
			})),
		)
	)
})

Deno.test('request decode rejects non-zero GET tsize', () => {
	assertThrows(() =>
		decodeRequestPacket(
			encodeRequestPacket(createRequest('GET', 'foo', {
				options: { tsize: 1 },
			})),
		)
	)
})
