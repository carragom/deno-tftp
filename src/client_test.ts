import { assertEquals, assertRejects } from '@std/assert'

import { Client } from './client.ts'
import { Server } from './server.ts'
import { createTFTPError, TFTPErrorCode } from './common.ts'
import { readBodyToBytes, streamFromBytes } from './utils.ts'

Deno.test('client get reads file served by local server', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/hello.txt`, 'hello')

	const server = new Server(undefined, { host: '127.0.0.1', port: 1069, root })
	await server.listen()
	try {
		const client = new Client({ host: '127.0.0.1', port: 1069 })
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
	const server = new Server(undefined, { host: '127.0.0.1', port: 1070, root })
	await server.listen()
	try {
		const client = new Client({ host: '127.0.0.1', port: 1070 })
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
			port: 1071,
		},
	)
	await server.listen()
	try {
		const client = new Client({ host: '127.0.0.1', port: 1071 })
		await assertRejects(() => client.get('missing.txt'))
	} finally {
		await server.close()
	}
})

Deno.test('client times out after configured retries when server is unreachable', async () => {
	const client = new Client({
		host: '127.0.0.1',
		port: 65069,
		timeout: 50,
		retries: 1,
	})
	const error = await assertRejects(() => client.get('missing.txt')) as {
		code: number
		message: string
	}
	assertEquals(error.code, TFTPErrorCode.NOT_DEFINED)
	assertEquals(error.message, 'Timed out')
})
