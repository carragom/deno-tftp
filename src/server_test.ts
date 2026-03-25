import { assertEquals } from '@std/assert'

import { createRequest, createTFTPError, TFTPErrorCode } from './common.ts'
import { route, Server } from './server.ts'
import { readBodyToBytes, streamFromBytes } from './utils.ts'

Deno.test('server serves existing regular file before custom handler', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/hello.txt`, 'root')

	const server = new Server(
		() => ({
			body: streamFromBytes(new TextEncoder().encode('handler')),
		}),
		{
			host: '127.0.0.1',
			port: 1080,
			root,
		},
	)
	await server.listen()
	try {
		const response = await server.request(createRequest('GET', 'hello.txt'), {
			address: '127.0.0.1',
			port: 9999,
		})
		assertEquals(
			new TextDecoder().decode(await readBodyToBytes(response.body)),
			'root',
		)
	} finally {
		await server.close()
	}
})

Deno.test('server route handles dynamic request', async () => {
	const handler = route([
		{
			method: 'GET',
			pattern: new URLPattern({ pathname: '/hello/:name' }),
			handler: (_request, _info) => ({
				body: streamFromBytes(new TextEncoder().encode('dynamic')),
			}),
		},
	], () => ({ error: createTFTPError(TFTPErrorCode.FILE_NOT_FOUND) }))

	const server = new Server(handler, { host: '127.0.0.1', port: 1081 })
	await server.listen()
	try {
		const response = await server.request(
			createRequest('GET', 'hello/world'),
			{
				address: '127.0.0.1',
				port: 9999,
			},
		)
		assertEquals(
			new TextDecoder().decode(await readBodyToBytes(response.body)),
			'dynamic',
		)
	} finally {
		await server.close()
	}
})

Deno.test('server rejects overwrite by default', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/file.txt`, 'old')
	const server = new Server(undefined, { host: '127.0.0.1', port: 1082, root })
	await server.listen()
	try {
		const response = await server.request(
			createRequest('PUT', 'file.txt', {
				body: streamFromBytes(new TextEncoder().encode('new')),
			}),
			{ address: '127.0.0.1', port: 9999 },
		)
		assertEquals(response.error?.code, TFTPErrorCode.FILE_EXISTS)
	} finally {
		await server.close()
	}
})

Deno.test('server creates directories recursively when enabled', async () => {
	const root = await Deno.makeTempDir()
	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 1083,
		root,
		allowCreateDir: true,
	})
	await server.listen()
	try {
		const response = await server.request(
			createRequest('PUT', 'nested/path/file.txt', {
				body: streamFromBytes(new TextEncoder().encode('value')),
			}),
			{ address: '127.0.0.1', port: 9999 },
		)
		assertEquals(response.error, undefined)
		assertEquals(
			await Deno.readTextFile(`${root}/nested/path/file.txt`),
			'value',
		)
	} finally {
		await server.close()
	}
})

Deno.test('server enforces maxPutSize', async () => {
	const root = await Deno.makeTempDir()
	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 1084,
		root,
		maxPutSize: 2,
	})
	await server.listen()
	try {
		const response = await server.request(
			createRequest('PUT', 'file.txt', {
				options: { tsize: 3 },
				body: streamFromBytes(new TextEncoder().encode('abc')),
			}),
			{ address: '127.0.0.1', port: 9999 },
		)
		assertEquals(response.error?.code, TFTPErrorCode.DISK_FULL)
	} finally {
		await server.close()
	}
})
