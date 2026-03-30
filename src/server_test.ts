import { assertEquals } from '@std/assert'

import { TFTPError, TFTPErrorCode, TFTPRequest } from './common.ts'
import type { ServerLogEntry } from './server.ts'
import { route, Server } from './server.ts'
import { readBodyToBytes, streamFromBytes } from './utils.ts'

function createCollector(): {
	entries: ServerLogEntry[]
	logger: (entry: Readonly<ServerLogEntry>) => void
} {
	const entries: ServerLogEntry[] = []
	return {
		entries,
		logger: (entry) => entries.push({ ...entry }),
	}
}

Deno.test('server serves existing regular file before custom handler', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/hello.txt`, 'root')

	const server = new Server(
		{
			host: '127.0.0.1',
			port: 0,
			root,
		},
		() => ({
			body: streamFromBytes(new TextEncoder().encode('handler')),
		}),
	)
	await server.listen()
	try {
		const response = await server.request({
			method: 'GET',
			path: 'hello.txt',
		}, {
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
			handler: (_request, params, info) => ({
				body: streamFromBytes(
					new TextEncoder().encode(
						`${params.pathname.groups.name}:${info.remote.address}`,
					),
				),
			}),
		},
	], () => ({ error: new TFTPError(TFTPErrorCode.FILE_NOT_FOUND) }))

	const server = new Server({ host: '127.0.0.1', port: 0 }, handler)
	await server.listen()
	try {
		const response = await server.request(
			{ method: 'GET', path: 'hello/world' },
			{
				address: '127.0.0.1',
				port: 9999,
			},
		)
		assertEquals(
			new TextDecoder().decode(await readBodyToBytes(response.body)),
			'world:127.0.0.1',
		)
	} finally {
		await server.close()
	}
})

Deno.test('server route falls back to default handler when unmatched', async () => {
	const handler = route(
		[
			{
				method: 'GET',
				pattern: new URLPattern({ pathname: '/hello/:name' }),
				handler: () => ({
					body: streamFromBytes(new TextEncoder().encode('matched')),
				}),
			},
		],
		(_request, info) => ({
			body: streamFromBytes(
				new TextEncoder().encode(`default:${info.remote.address}`),
			),
		}),
	)

	const server = new Server({ host: '127.0.0.1', port: 0 }, handler)
	await server.listen()
	try {
		const response = await server.request(
			{ method: 'GET', path: 'goodbye/world' },
			{
				address: '127.0.0.1',
				port: 9999,
			},
		)
		assertEquals(
			new TextDecoder().decode(await readBodyToBytes(response.body)),
			'default:127.0.0.1',
		)
	} finally {
		await server.close()
	}
})

Deno.test('server request accepts request init objects', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/hello.txt`, 'root')

	const server = new Server({ host: '127.0.0.1', port: 0, root })
	await server.listen()
	try {
		const response = await server.request(
			{ method: 'GET', path: 'hello.txt' },
			{ address: '127.0.0.1', port: 9999 },
		)
		assertEquals(
			new TextDecoder().decode(await readBodyToBytes(response.body)),
			'root',
		)
	} finally {
		await server.close()
	}
})

Deno.test('server request accepts request instances', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/hello.txt`, 'root')

	const server = new Server({ host: '127.0.0.1', port: 0, root })
	await server.listen()
	try {
		const response = await server.request(
			new TFTPRequest({ method: 'GET', path: 'hello.txt' }),
			{ address: '127.0.0.1', port: 9999 },
		)
		assertEquals(
			new TextDecoder().decode(await readBodyToBytes(response.body)),
			'root',
		)
	} finally {
		await server.close()
	}
})

Deno.test('server rejects overwrite by default', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/file.txt`, 'old')
	const server = new Server({ host: '127.0.0.1', port: 0, root })
	await server.listen()
	try {
		const response = await server.request(
			{
				method: 'PUT',
				path: 'file.txt',
				body: streamFromBytes(new TextEncoder().encode('new')),
			},
			{ address: '127.0.0.1', port: 9999 },
		)
		assertEquals(response.error?.code, TFTPErrorCode.FILE_EXISTS)
	} finally {
		await server.close()
	}
})

Deno.test('server creates directories recursively when enabled', async () => {
	const root = await Deno.makeTempDir()
	const server = new Server({
		host: '127.0.0.1',
		port: 0,
		root,
		allowCreateDir: true,
	})
	await server.listen()
	try {
		const response = await server.request(
			{
				method: 'PUT',
				path: 'nested/path/file.txt',
				body: streamFromBytes(new TextEncoder().encode('value')),
			},
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
	const server = new Server({
		host: '127.0.0.1',
		port: 0,
		root,
		maxPutSize: 2,
	})
	await server.listen()
	try {
		const response = await server.request(
			{
				method: 'PUT',
				path: 'file.txt',
				options: { tsize: 3 },
				body: streamFromBytes(new TextEncoder().encode('abc')),
			},
			{ address: '127.0.0.1', port: 9999 },
		)
		assertEquals(response.error?.code, TFTPErrorCode.DISK_FULL)
	} finally {
		await server.close()
	}
})

Deno.test('server emits listen and close log events', async () => {
	const { entries, logger } = createCollector()
	const server = new Server({ host: '127.0.0.1', port: 0, logger })
	await server.listen()
	await server.close()

	assertEquals(entries.map((entry) => entry.event), [
		'server.listen',
		'server.close',
	])
	assertEquals(entries.map((entry) => entry.source), ['server', 'server'])
})

Deno.test('server logs root dispatch and persistence events', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/hello.txt`, 'root')
	const { entries, logger } = createCollector()
	const server = new Server({ host: '127.0.0.1', port: 0, root, logger })
	await server.listen()
	try {
		await server.request(
			{ method: 'GET', path: 'hello.txt' },
			{ address: '127.0.0.1', port: 9999 },
		)
		await server.request(
			{
				method: 'PUT',
				path: 'upload.txt',
				body: streamFromBytes(new TextEncoder().encode('upload')),
			},
			{ address: '127.0.0.1', port: 9999 },
		)
	} finally {
		await server.close()
	}

	assertEquals(
		entries
			.filter((entry) => entry.event === 'request.dispatch')
			.map((entry) => entry.source),
		['root', 'root'],
	)
	assertEquals(
		entries.some((entry) =>
			entry.event === 'request.persisted' && entry.source === 'root' &&
			entry.path === 'upload.txt' && entry.bytes === 6
		),
		true,
	)
})

Deno.test('server logs handler dispatch source', async () => {
	const { entries, logger } = createCollector()
	const server = new Server(
		{ host: '127.0.0.1', port: 0, logger },
		() => ({ body: streamFromBytes(new TextEncoder().encode('handler')) }),
	)
	await server.listen()
	try {
		await server.request(
			{ method: 'GET', path: 'hello.txt' },
			{ address: '127.0.0.1', port: 9999 },
		)
	} finally {
		await server.close()
	}

	assertEquals(
		entries.some((entry) =>
			entry.event === 'request.dispatch' && entry.source === 'handler'
		),
		true,
	)
})

Deno.test('server logs builtin error dispatch source', async () => {
	const { entries, logger } = createCollector()
	const server = new Server({ host: '127.0.0.1', port: 0, logger })
	await server.listen()
	try {
		const response = await server.request(
			{ method: 'GET', path: 'missing.txt' },
			{ address: '127.0.0.1', port: 9999 },
		)
		assertEquals(response.error?.code, TFTPErrorCode.FILE_NOT_FOUND)
	} finally {
		await server.close()
	}

	assertEquals(
		entries.some((entry) =>
			entry.event === 'request.dispatch' && entry.source === 'builtin_error'
		),
		true,
	)
})

Deno.test('server logs denyGET and overwrite denial', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/file.txt`, 'old')
	const { entries, logger } = createCollector()
	const denyServer = new Server({
		host: '127.0.0.1',
		port: 0,
		denyGET: true,
		logger,
	})
	await denyServer.listen()
	try {
		await denyServer.request(
			{ method: 'GET', path: 'file.txt' },
			{ address: '127.0.0.1', port: 9999 },
		)
	} finally {
		await denyServer.close()
	}

	const overwriteServer = new Server({
		host: '127.0.0.1',
		port: 0,
		root,
		logger,
	})
	await overwriteServer.listen()
	try {
		await overwriteServer.request(
			{
				method: 'PUT',
				path: 'file.txt',
				body: streamFromBytes(new TextEncoder().encode('new')),
			},
			{ address: '127.0.0.1', port: 9999 },
		)
	} finally {
		await overwriteServer.close()
	}

	assertEquals(
		entries.some((entry) =>
			entry.event === 'request.denied' && entry.source === 'server' &&
			entry.method === 'GET'
		),
		true,
	)
	assertEquals(
		entries.some((entry) =>
			entry.event === 'request.denied' && entry.source === 'root' &&
			entry.method === 'PUT' && entry.path === 'file.txt'
		),
		true,
	)
})

Deno.test('server ignores logger callback failures', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/hello.txt`, 'root')
	const server = new Server({
		host: '127.0.0.1',
		port: 0,
		root,
		logger: () => {
			throw new Error('logger failed')
		},
	})
	await server.listen()
	try {
		const response = await server.request(
			{ method: 'GET', path: 'hello.txt' },
			{ address: '127.0.0.1', port: 9999 },
		)
		assertEquals(
			new TextDecoder().decode(await readBodyToBytes(response.body)),
			'root',
		)
	} finally {
		await server.close()
	}
})
