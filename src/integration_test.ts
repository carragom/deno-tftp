import { assertEquals } from '@std/assert'

import { Client } from './client.ts'
import { Server } from './server.ts'
import {
	parseInteropServers,
	readBodyToBytes,
	streamFromBytes,
} from './utils.ts'

const interopServerValue = Deno.env.get('TEST_INTEROP_SERVER')
const TEST_TIMEOUT_MS = 150
const TEST_RETRIES = 1
const interopServers = interopServerValue
	? parseInteropServers(interopServerValue)
	: []
const interopClientEnabled = isInteropClientEnabled(
	Deno.env.get('TEST_INTEROP_CLIENT'),
)
const hasAtftp = interopClientEnabled && await commandExists('atftp')
const hasTftp = interopClientEnabled && await commandExists('tftp')

Deno.test('client and server interoperate in-process', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/hello.txt`, 'hello')

	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 0,
		root,
		timeout: TEST_TIMEOUT_MS,
		retries: TEST_RETRIES,
	})
	await server.listen()
	try {
		const client = new Client({
			host: server.host,
			port: server.port,
			timeout: TEST_TIMEOUT_MS,
			retries: TEST_RETRIES,
		})
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
		port: 0,
		root,
		blockSize: 1024,
		windowSize: 4,
		timeout: TEST_TIMEOUT_MS,
		retries: TEST_RETRIES,
	})
	await server.listen()
	try {
		const client = new Client({
			host: server.host,
			port: server.port,
			blockSize: 1024,
			windowSize: 4,
			timeout: TEST_TIMEOUT_MS,
			retries: TEST_RETRIES,
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

	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 0,
		root,
		timeout: TEST_TIMEOUT_MS,
		retries: TEST_RETRIES,
	})
	await server.listen()
	try {
		const jobs = Array.from({ length: 8 }, async () => {
			const client = new Client({
				host: server.host,
				port: server.port,
				timeout: TEST_TIMEOUT_MS,
				retries: TEST_RETRIES,
			})
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
	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 0,
		root,
		timeout: TEST_TIMEOUT_MS,
		retries: TEST_RETRIES,
	})
	await server.listen()
	try {
		await Promise.all(Array.from({ length: 6 }, async (_, index) => {
			const client = new Client({
				host: server.host,
				port: server.port,
				timeout: TEST_TIMEOUT_MS,
				retries: TEST_RETRIES,
			})
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

	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 0,
		root,
		timeout: TEST_TIMEOUT_MS,
		retries: TEST_RETRIES,
	})
	await server.listen()
	try {
		const client = new Client({
			host: server.host,
			port: server.port,
			blockSize: 64,
			timeout: TEST_TIMEOUT_MS,
			retries: TEST_RETRIES,
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
	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 0,
		root,
		timeout: TEST_TIMEOUT_MS,
		retries: TEST_RETRIES,
	})
	await server.listen()
	try {
		const client = new Client({
			host: server.host,
			port: server.port,
			blockSize: 64,
			timeout: TEST_TIMEOUT_MS,
			retries: TEST_RETRIES,
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

for (const target of interopServers) {
	Deno.test({
		name:
			`client can talk to external interop server ${target.host}:${target.port}`,
		ignore: !interopServerValue,
		async fn() {
			const client = new Client({ host: target.host, port: target.port })
			const response = await client.get('hello.txt')
			assertEquals(
				new TextDecoder().decode(await readBodyToBytes(response.body)),
				'hello\n',
			)
		},
	})

	Deno.test({
		name:
			`client negotiates options with external interop server ${target.host}:${target.port}`,
		ignore: !interopServerValue,
		async fn() {
			const client = new Client({
				host: target.host,
				port: target.port,
				blockSize: 1024,
				windowSize: 4,
			})
			const response = await client.get('hello.txt')
			assertEquals(
				new TextDecoder().decode(await readBodyToBytes(response.body)),
				'hello\n',
			)
			assertEquals(response.options?.blksize, 1024)
			assertEquals(response.options?.windowsize, 4)
			assertEquals(response.options?.tsize, 6)
		},
	})
}

Deno.test({
	name: 'atftp client can GET from this server',
	ignore: !hasAtftp,
	async fn() {
		await withInteropServer(async (server, root) => {
			await Deno.writeTextFile(`${root}/hello.txt`, 'hello\n')
			const outputFile = `${root}/download.txt`
			const output = await new Deno.Command('atftp', {
				args: [
					'--get',
					'--local-file',
					outputFile,
					'--remote-file',
					'hello.txt',
					'127.0.0.1',
					String(server.port),
				],
				stdout: 'piped',
				stderr: 'piped',
			}).output()
			assertCommandSucceeded(output)
			assertEquals(await Deno.readTextFile(outputFile), 'hello\n')
		})
	},
})

Deno.test({
	name: 'atftp client can PUT to this server',
	ignore: !hasAtftp,
	async fn() {
		await withInteropServer(async (server, root) => {
			const inputFile = `${root}/input.txt`
			await Deno.writeTextFile(inputFile, 'uploaded via atftp\n')
			const output = await new Deno.Command('atftp', {
				args: [
					'--put',
					'--local-file',
					inputFile,
					'--remote-file',
					'upload.txt',
					'127.0.0.1',
					String(server.port),
				],
				stdout: 'piped',
				stderr: 'piped',
			}).output()
			assertCommandSucceeded(output)
			assertEquals(
				await Deno.readTextFile(`${root}/upload.txt`),
				'uploaded via atftp\n',
			)
		})
	},
})

Deno.test({
	name: 'atftp client negotiates blksize with this server',
	ignore: !hasAtftp,
	async fn() {
		await withInteropServer(async (server, root) => {
			const payload = 'x'.repeat(4096)
			await Deno.writeTextFile(`${root}/big.txt`, payload)
			const outputFile = `${root}/blksize.txt`
			const output = await new Deno.Command('atftp', {
				args: [
					'--get',
					'--local-file',
					outputFile,
					'--remote-file',
					'big.txt',
					'--option',
					'blksize 1024',
					'127.0.0.1',
					String(server.port),
				],
				stdout: 'piped',
				stderr: 'piped',
			}).output()
			assertCommandSucceeded(output)
			assertEquals(await Deno.readTextFile(outputFile), payload)
		})
	},
})

Deno.test({
	name: 'atftp client negotiates timeout with this server',
	ignore: !hasAtftp,
	async fn() {
		await withInteropServer(async (server, root) => {
			await Deno.writeTextFile(`${root}/hello.txt`, 'hello\n')
			const outputFile = `${root}/timeout.txt`
			const output = await new Deno.Command('atftp', {
				args: [
					'--get',
					'--local-file',
					outputFile,
					'--remote-file',
					'hello.txt',
					'--option',
					'timeout 1',
					'127.0.0.1',
					String(server.port),
				],
				stdout: 'piped',
				stderr: 'piped',
			}).output()
			assertCommandSucceeded(output)
			assertEquals(await Deno.readTextFile(outputFile), 'hello\n')
		})
	},
})

Deno.test({
	name: 'atftp client negotiates windowsize with this server',
	ignore: !hasAtftp,
	async fn() {
		await withInteropServer(async (server, root) => {
			const payload = 'x'.repeat(4096)
			await Deno.writeTextFile(`${root}/window.txt`, payload)
			const outputFile = `${root}/window.out`
			const output = await new Deno.Command('atftp', {
				args: [
					'--get',
					'--local-file',
					outputFile,
					'--remote-file',
					'window.txt',
					'--option',
					'windowsize 4',
					'127.0.0.1',
					String(server.port),
				],
				stdout: 'piped',
				stderr: 'piped',
			}).output()
			assertCommandSucceeded(output)
			assertEquals(await Deno.readTextFile(outputFile), payload)
		})
	},
})

Deno.test({
	name: 'atftp client negotiates tsize with this server',
	ignore: !hasAtftp,
	async fn() {
		await withInteropServer(async (server, root) => {
			await Deno.writeTextFile(`${root}/hello.txt`, 'hello\n')
			const outputFile = `${root}/tsize.txt`
			const output = await new Deno.Command('atftp', {
				args: [
					'--get',
					'--local-file',
					outputFile,
					'--remote-file',
					'hello.txt',
					'--option',
					'tsize 0',
					'127.0.0.1',
					String(server.port),
				],
				stdout: 'piped',
				stderr: 'piped',
			}).output()
			assertCommandSucceeded(output)
			assertEquals(await Deno.readTextFile(outputFile), 'hello\n')
		})
	},
})

Deno.test({
	name: 'tftp client can GET from this server',
	ignore: !hasTftp,
	async fn() {
		await withInteropServer(async (server, root) => {
			await Deno.writeTextFile(`${root}/hello.txt`, 'hello\n')
			const outputFile = `${root}/download.txt`
			const output = await new Deno.Command('tftp', {
				args: [
					'127.0.0.1',
					String(server.port),
					'-c',
					'get',
					'hello.txt',
					outputFile,
				],
				stdout: 'piped',
				stderr: 'piped',
			}).output()
			assertCommandSucceeded(output)
			assertEquals(await Deno.readTextFile(outputFile), 'hello\n')
		})
	},
})

Deno.test({
	name: 'tftp client can PUT to this server',
	ignore: !hasTftp,
	async fn() {
		await withInteropServer(async (server, root) => {
			const inputFile = `${root}/input.txt`
			await Deno.writeTextFile(inputFile, 'uploaded via tftp\n')
			const output = await new Deno.Command('tftp', {
				args: [
					'127.0.0.1',
					String(server.port),
					'-c',
					'put',
					inputFile,
					'upload.txt',
				],
				stdout: 'piped',
				stderr: 'piped',
			}).output()
			assertCommandSucceeded(output)
			assertEquals(
				await Deno.readTextFile(`${root}/upload.txt`),
				'uploaded via tftp\n',
			)
		})
	},
})

async function withInteropServer(
	run: (server: Server, root: string) => Promise<void>,
): Promise<void> {
	const root = await Deno.makeTempDir()
	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 0,
		root,
		blockSize: 1024,
		windowSize: 4,
	})
	await server.listen()
	try {
		await run(server, root)
	} finally {
		await server.close()
	}
}

function isInteropClientEnabled(value: string | undefined): boolean {
	if (!value) return false
	const normalized = value.toLowerCase()
	return normalized === 'y' || normalized === 'yes'
}

async function commandExists(name: string): Promise<boolean> {
	const output = await new Deno.Command('sh', {
		args: ['-c', `command -v ${name} >/dev/null 2>&1`],
		stdout: 'null',
		stderr: 'null',
	}).output()
	return output.success
}

function assertCommandSucceeded(output: Deno.CommandOutput): void {
	if (!output.success) {
		throw new Error(new TextDecoder().decode(output.stderr))
	}
}
