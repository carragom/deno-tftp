import { assertEquals, assertRejects, assertThrows } from '@std/assert'

import {
	canonicalizeRoot,
	normalizeClientOptions,
	normalizeServerOptions,
	normalizeTFTPPath,
	parseInteropServer,
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
