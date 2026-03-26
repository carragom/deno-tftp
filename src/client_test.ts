import { assertEquals, assertRejects } from '@std/assert'

import { Client } from './client.ts'
import { Server } from './server.ts'
import { OperationTimeoutError, TFTPError, TFTPErrorCode } from './common.ts'
import { readBodyToBytes, streamFromBytes } from './utils.ts'

const UNREACHABLE_TEST_PORT = 65069
const TEST_TIMEOUT_MS = 100
const TEST_RETRIES = 1
const unreachableTestPortBusy = isUdpPortBusy(UNREACHABLE_TEST_PORT)

Deno.test('client get reads file served by local server', async () => {
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
		const response = await client.get('hello.txt')
		assertEquals(
			new TextDecoder().decode(await readBodyToBytes(response.body)),
			'hello',
		)
	} finally {
		await server.close()
	}
})

Deno.test('client put uploads bytes to built-in root', async () => {
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
			timeout: TEST_TIMEOUT_MS,
			retries: TEST_RETRIES,
		})
		await client.put(
			'upload.bin',
			streamFromBytes(new TextEncoder().encode('abc')),
		)
		assertEquals(await Deno.readTextFile(`${root}/upload.bin`), 'abc')
	} finally {
		await server.close()
	}
})

Deno.test('client request rejects TFTP errors', async () => {
	const server = new Server(
		() => ({
			error: new TFTPError(TFTPErrorCode.ACCESS_VIOLATION, 'nope'),
		}),
		{
			host: '127.0.0.1',
			port: 0,
			timeout: TEST_TIMEOUT_MS,
			retries: TEST_RETRIES,
		},
	)
	await server.listen()
	try {
		const client = new Client({
			host: server.host,
			port: server.port,
			timeout: TEST_TIMEOUT_MS,
			retries: TEST_RETRIES,
		})
		await assertRejects(() => client.get('missing.txt'))
	} finally {
		await server.close()
	}
})

Deno.test('client request GET overload downloads a file', async () => {
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
		const response = await client.request('hello.txt', 'GET')
		assertEquals(
			new TextDecoder().decode(await readBodyToBytes(response.body)),
			'hello',
		)
	} finally {
		await server.close()
	}
})

Deno.test('client request PUT overload uploads a body stream', async () => {
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
			timeout: TEST_TIMEOUT_MS,
			retries: TEST_RETRIES,
		})
		await client.request(
			'hello.txt',
			'PUT',
			streamFromBytes(new TextEncoder().encode('hello')),
		)
		assertEquals(
			await Deno.readTextFile(`${root}/hello.txt`),
			'hello',
		)
	} finally {
		await server.close()
	}
})

Deno.test('client request options override instance defaults', async () => {
	const requests: Array<{
		options: Readonly<Record<string, unknown>>
	}> = []
	const server = new Server((request) => {
		requests.push({
			options: request.options as Readonly<Record<string, unknown>>,
		})
		return { body: streamFromBytes(new TextEncoder().encode('hello')) }
	}, {
		host: '127.0.0.1',
		port: 0,
		timeout: TEST_TIMEOUT_MS,
		retries: TEST_RETRIES,
	})
	await server.listen()
	try {
		const client = new Client({
			host: server.host,
			port: server.port,
			blockSize: 512,
			windowSize: 1,
			timeout: TEST_TIMEOUT_MS,
			retries: TEST_RETRIES,
		})
		await client.request('hello.txt', 'GET', {
			options: { blksize: 1024, windowsize: 4, timeout: 2 },
		})
		assertEquals(requests[0].options.blksize, 1024)
		assertEquals(requests[0].options.windowsize, 4)
		assertEquals(requests[0].options.timeout, 2)
	} finally {
		await server.close()
	}
})

Deno.test('client request falls back to instance defaults', async () => {
	const requests: Array<{
		options: Readonly<Record<string, unknown>>
	}> = []
	const server = new Server((request) => {
		requests.push({
			options: request.options as Readonly<Record<string, unknown>>,
		})
		return { body: streamFromBytes(new TextEncoder().encode('hello')) }
	}, {
		host: '127.0.0.1',
		port: 0,
		timeout: TEST_TIMEOUT_MS,
		retries: TEST_RETRIES,
	})
	await server.listen()
	try {
		const client = new Client({
			host: server.host,
			port: server.port,
			blockSize: 768,
			windowSize: 3,
			timeout: TEST_TIMEOUT_MS,
			retries: TEST_RETRIES,
		})
		await client.request('hello.txt', 'GET')
		assertEquals(requests[0].options.blksize, 768)
		assertEquals(requests[0].options.windowsize, 3)
		assertEquals(requests[0].options.timeout, 1)
		assertEquals(requests[0].options.tsize, 0)
	} finally {
		await server.close()
	}
})

Deno.test({
	name: 'client times out after configured retries when server is unreachable',
	ignore: unreachableTestPortBusy,
	async fn() {
		const client = new Client({
			host: '127.0.0.1',
			port: UNREACHABLE_TEST_PORT,
			timeout: 50,
			retries: 1,
		})
		const error = await assertRejects(() => client.get('missing.txt')) as {
			message: string
		}
		if (!(error instanceof OperationTimeoutError)) {
			throw error
		}
		assertEquals(error.message, 'Timed out')
	},
})

function isUdpPortBusy(port: number): boolean {
	try {
		const socket = Deno.listenDatagram({
			transport: 'udp',
			hostname: '127.0.0.1',
			port,
		})
		socket.close()
		return false
	} catch {
		return true
	}
}
