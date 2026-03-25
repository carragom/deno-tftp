import { assertEquals } from '@std/assert'

import { Client } from './client.ts'
import { Server } from './server.ts'
import {
	parseInteropServer,
	readBodyToBytes,
	streamFromBytes,
} from './utils.ts'

Deno.test('client and server interoperate in-process', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/hello.txt`, 'hello')

	const server = new Server(undefined, { host: '127.0.0.1', port: 1090, root })
	await server.listen()
	try {
		const client = new Client({ host: '127.0.0.1', port: 1090 })
		const getResponse = await client.get('hello.txt')
		assertEquals(
			new TextDecoder().decode(await readBodyToBytes(getResponse.body)),
			'hello',
		)

		await client.put(
			'upload.txt',
			streamFromBytes(new TextEncoder().encode('upload')),
		)
		assertEquals(await Deno.readTextFile(`${root}/upload.txt`), 'upload')
	} finally {
		await server.close()
	}
})

Deno.test('client and server negotiate windowsize and blocksize in-process', async () => {
	const root = await Deno.makeTempDir()
	const payload = 'x'.repeat(3000)
	await Deno.writeTextFile(`${root}/big.txt`, payload)

	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 1092,
		root,
		blockSize: 1024,
		windowSize: 4,
	})
	await server.listen()
	try {
		const client = new Client({
			host: '127.0.0.1',
			port: 1092,
			blockSize: 1024,
			windowSize: 4,
		})
		const response = await client.get('big.txt')
		assertEquals(
			new TextDecoder().decode(await readBodyToBytes(response.body)),
			payload,
		)
		assertEquals(response.options?.blksize, 1024)
		assertEquals(response.options?.windowsize, 4)
	} finally {
		await server.close()
	}
})

Deno.test('client and server handle concurrent RRQ in-process', async () => {
	const root = await Deno.makeTempDir()
	const payload = 'x'.repeat(4096)
	await Deno.writeTextFile(`${root}/shared.txt`, payload)

	const server = new Server(undefined, { host: '127.0.0.1', port: 1089, root })
	await server.listen()
	try {
		const jobs = Array.from({ length: 8 }, async () => {
			const client = new Client({ host: '127.0.0.1', port: 1089 })
			const response = await client.get('shared.txt')
			return new TextDecoder().decode(await readBodyToBytes(response.body))
		})
		assertEquals(await Promise.all(jobs), Array(8).fill(payload))
	} finally {
		await server.close()
	}
})

Deno.test('client and server handle concurrent WRQ in-process', async () => {
	const root = await Deno.makeTempDir()
	const server = new Server(undefined, { host: '127.0.0.1', port: 1088, root })
	await server.listen()
	try {
		await Promise.all(Array.from({ length: 6 }, async (_, index) => {
			const client = new Client({ host: '127.0.0.1', port: 1088 })
			const body = `upload-${index}`
			await client.put(
				`upload-${index}.txt`,
				streamFromBytes(new TextEncoder().encode(body)),
			)
			assertEquals(
				await Deno.readTextFile(`${root}/upload-${index}.txt`),
				body,
			)
		}))
	} finally {
		await server.close()
	}
})

Deno.test('client and server translate netascii on GET in-process', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/unix.txt`, 'foo\nbar\rbaz\n')

	const server = new Server(undefined, { host: '127.0.0.1', port: 1087, root })
	await server.listen()
	try {
		const client = new Client({
			host: '127.0.0.1',
			port: 1087,
			blockSize: 64,
		})
		const response = await client.get('unix.txt', { mode: 'netascii' })
		assertEquals(
			new TextDecoder().decode(await readBodyToBytes(response.body)),
			'foo\nbar\rbaz\n',
		)
	} finally {
		await server.close()
	}
})

Deno.test('client and server translate netascii on PUT in-process', async () => {
	const root = await Deno.makeTempDir()
	const server = new Server(undefined, { host: '127.0.0.1', port: 1086, root })
	await server.listen()
	try {
		const client = new Client({
			host: '127.0.0.1',
			port: 1086,
			blockSize: 64,
		})
		await client.put(
			'unix.txt',
			streamFromBytes(new TextEncoder().encode('foo\nbar\rbaz\n')),
			{ mode: 'netascii' },
		)
		assertEquals(
			await Deno.readTextFile(`${root}/unix.txt`),
			'foo\nbar\rbaz\n',
		)
	} finally {
		await server.close()
	}
})

Deno.test('client interop tests are gated by TEST_INTEROP_SERVER', () => {
	const value = Deno.env.get('TEST_INTEROP_SERVER')
	if (!value) {
		return
	}
	const parsed = parseInteropServer(value)
	assertEquals(typeof parsed.host, 'string')
	assertEquals(typeof parsed.port, 'number')
})

Deno.test('server interop tests are gated by TEST_INTEROP_CLIENT', () => {
	const value = Deno.env.get('TEST_INTEROP_CLIENT')
	if (!value) {
		return
	}
	if (value !== 'atftp' && value !== 'tftp') {
		throw new Error(`Unsupported TEST_INTEROP_CLIENT value: ${value}`)
	}
})

Deno.test('client can talk to external interop server when configured', async () => {
	const value = Deno.env.get('TEST_INTEROP_SERVER')
	if (!value) return

	const { host, port } = parseInteropServer(value)
	const client = new Client({ host, port })
	const response = await client.get('hello.txt')
	assertEquals(
		new TextDecoder().decode(await readBodyToBytes(response.body)),
		'hello\n',
	)
})

Deno.test('client negotiates options with external interop server when configured', async () => {
	const value = Deno.env.get('TEST_INTEROP_SERVER')
	if (!value) return

	const { host, port } = parseInteropServer(value)
	const client = new Client({ host, port, blockSize: 1024, windowSize: 4 })
	const response = await client.get('hello.txt')
	assertEquals(
		new TextDecoder().decode(await readBodyToBytes(response.body)),
		'hello\n',
	)
	assertEquals(response.options?.blksize, 1024)
	assertEquals(response.options?.windowsize, 4)
	assertEquals(response.options?.tsize, 6)
})

Deno.test('external interop client can talk to this server when configured', async () => {
	const clientName = Deno.env.get('TEST_INTEROP_CLIENT')
	if (!clientName) return

	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/hello.txt`, 'hello\n')

	const server = new Server(undefined, { host: '127.0.0.1', port: 1091, root })
	await server.listen()
	try {
		if (clientName === 'atftp') {
			const command = new Deno.Command('atftp', {
				args: [
					'--get',
					'--local-file',
					'-',
					'--remote-file',
					'hello.txt',
					'127.0.0.1',
					'1091',
				],
				stdout: 'piped',
			})
			const output = await command.output()
			assertEquals(new TextDecoder().decode(output.stdout), 'hello\n')
		} else {
			const command = new Deno.Command('tftp', {
				args: ['127.0.0.1', '1091'],
				stdin: 'piped',
				stdout: 'piped',
			})
			const child = command.spawn()
			const writer = child.stdin.getWriter()
			await writer.write(new TextEncoder().encode('get hello.txt -\nquit\n'))
			await writer.close()
			const output = await child.output()
			assertEquals(
				new TextDecoder().decode(output.stdout).includes('hello'),
				true,
			)
		}
	} finally {
		await server.close()
	}
})

Deno.test('external interop client can upload to this server when configured', async () => {
	const clientName = Deno.env.get('TEST_INTEROP_CLIENT')
	if (!clientName) return

	const root = await Deno.makeTempDir()
	const inputFile = `${root}/input.txt`
	await Deno.writeTextFile(inputFile, 'uploaded via interop\n')

	const server = new Server(undefined, { host: '127.0.0.1', port: 1096, root })
	await server.listen()
	try {
		if (clientName === 'atftp') {
			const command = new Deno.Command('atftp', {
				args: [
					'--put',
					'--local-file',
					inputFile,
					'--remote-file',
					'upload.txt',
					'127.0.0.1',
					'1096',
				],
				stdout: 'piped',
				stderr: 'piped',
			})
			const output = await command.output()
			if (!output.success) {
				throw new Error(new TextDecoder().decode(output.stderr))
			}
		} else {
			const command = new Deno.Command('tftp', {
				args: ['127.0.0.1', '1096'],
				stdin: 'piped',
				stdout: 'piped',
				stderr: 'piped',
			})
			const child = command.spawn()
			const writer = child.stdin.getWriter()
			await writer.write(
				new TextEncoder().encode(`put ${inputFile} upload.txt\nquit\n`),
			)
			await writer.close()
			const output = await child.output()
			if (!output.success) {
				throw new Error(new TextDecoder().decode(output.stderr))
			}
		}

		assertEquals(
			await Deno.readTextFile(`${root}/upload.txt`),
			'uploaded via interop\n',
		)
	} finally {
		await server.close()
	}
})
