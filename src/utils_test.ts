import { assertEquals, assertRejects, assertThrows } from '@std/assert'

import {
	canonicalizeRoot,
	decodeNetascii,
	encodeNetascii,
	normalizeClientOptions,
	normalizeServerOptions,
	normalizeTFTPPath,
	parseInteropServer,
	parseInteropServers,
	parseTFTPUri,
	resolvePutTarget,
	resolveReadPath,
} from './utils.ts'

Deno.test('normalizeTFTPPath strips leading slash and rejects escape', () => {
	assertEquals(normalizeTFTPPath('/boot/file.bin'), 'boot/file.bin')
	assertThrows(() => normalizeTFTPPath('../etc/passwd'))
})

Deno.test('parseTFTPUri parses host port and mode', () => {
	assertEquals(
		parseTFTPUri('tftp://127.0.0.1:1069/boot/file.bin;mode=octet'),
		{
			host: '127.0.0.1',
			port: 1069,
			path: 'boot/file.bin',
			mode: 'octet',
		},
	)
})

Deno.test('parseInteropServer defaults port 69', () => {
	assertEquals(parseInteropServer('127.0.0.1'), {
		host: '127.0.0.1',
		port: 69,
	})
})

Deno.test('parseInteropServers supports comma-separated targets', () => {
	assertEquals(parseInteropServers('127.0.0.1,example.com:1069'), [
		{ host: '127.0.0.1', port: 69 },
		{ host: 'example.com', port: 1069 },
	])
})

Deno.test('normalize client and server options apply defaults', () => {
	assertEquals(normalizeClientOptions().port, 69)
	assertEquals(normalizeServerOptions().allowCreateFile, true)
})

Deno.test('root resolution rejects symlink reads', async () => {
	const root = await Deno.makeTempDir()
	const outside = await Deno.makeTempDir()
	await Deno.writeTextFile(`${outside}/secret.txt`, 'x')
	await Deno.symlink(`${outside}/secret.txt`, `${root}/secret.txt`)
	const canonical = await canonicalizeRoot(root)
	await assertRejects(() => resolveReadPath(canonical, 'secret.txt'))
})

Deno.test('resolvePutTarget validates nearest existing parent', async () => {
	const root = await Deno.makeTempDir()
	const canonical = await canonicalizeRoot(root)
	const resolved = await resolvePutTarget(canonical, 'nested/file.txt')
	assertEquals(resolved.relativePath, 'nested/file.txt')
})

Deno.test('netascii encoding follows CRLF and CRNUL rules', () => {
	const input = new Uint8Array([
		0x66,
		0x6f,
		0x6f,
		0x0a,
		0x62,
		0x61,
		0x72,
		0x0d,
		0x62,
		0x61,
		0x7a,
		0x0a,
	])
	assertEquals(
		Array.from(encodeNetascii(input)),
		[
			0x66,
			0x6f,
			0x6f,
			0x0d,
			0x0a,
			0x62,
			0x61,
			0x72,
			0x0d,
			0x00,
			0x62,
			0x61,
			0x7a,
			0x0d,
			0x0a,
		],
	)
})

Deno.test('netascii decoding restores local bytes', () => {
	const input = new Uint8Array([
		0x66,
		0x6f,
		0x6f,
		0x0d,
		0x0a,
		0x62,
		0x61,
		0x72,
		0x0d,
		0x00,
		0x62,
		0x61,
		0x7a,
		0x0d,
		0x0a,
	])
	assertEquals(
		Array.from(decodeNetascii(input)),
		[0x66, 0x6f, 0x6f, 0x0a, 0x62, 0x61, 0x72, 0x0d, 0x62, 0x61, 0x7a, 0x0a],
	)
})
