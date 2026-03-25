import { assertEquals, assertRejects } from '@std/assert'

import { Client } from './client.ts'
import { Server } from './server.ts'
import { createTFTPError, TFTPErrorCode } from './common.ts'
import { readBodyToBytes, streamFromBytes } from './utils.ts'

const UNREACHABLE_TEST_PORT = 65069
const unreachableTestPortBusy = isUdpPortBusy(UNREACHABLE_TEST_PORT)

Deno.test('client get reads file served by local server', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/hello.txt`, 'hello')

	const server = new Server(undefined, { host: '127.0.0.1', port: 0, root })
	await server.listen()
	try {
		const client = new Client({ host: server.host, port: server.port })
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
	const server = new Server(undefined, { host: '127.0.0.1', port: 0, root })
	await server.listen()
	try {
		const client = new Client({ host: server.host, port: server.port })
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
		() => ({ error: createTFTPError(2, 'nope') }),
		{
			host: '127.0.0.1',
			port: 0,
		},
	)
	await server.listen()
	try {
		const client = new Client({ host: server.host, port: server.port })
		await assertRejects(() => client.get('missing.txt'))
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
			code: number
			message: string
		}
		assertEquals(error.code, TFTPErrorCode.NOT_DEFINED)
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
