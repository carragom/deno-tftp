import { deadline } from '@std/async'
import { assertEquals, assertRejects } from '@std/assert'

import { Client } from './client.ts'
import {
	createRequest,
	decodeAckPacket,
	decodeDataPacket,
	decodeErrorPacket,
	decodeOptionsAckPacket,
	decodeRequestPacket,
	encodeAckPacket,
	encodeDataPacket,
	encodeOptionsAckPacket,
	encodeRequestPacket,
	TFTPErrorCode,
} from './common.ts'
import { Server } from './server.ts'
import { streamFromBytes } from './utils.ts'

type UdpAddr = Deno.NetAddr & { transport: 'udp' }

Deno.test('client rejects server OACK that increases requested windowsize', async () => {
	const server = new Server(
		() => ({
			options: { blksize: 512, windowsize: 8 },
			body: streamFromBytes(new Uint8Array()),
		}),
		{ host: '127.0.0.1', port: 1093 },
	)
	await server.listen()
	try {
		const client = new Client({
			host: '127.0.0.1',
			port: 1093,
			windowSize: 4,
		})
		await assertRejects(() => client.get('bad.txt'))
	} finally {
		await server.close()
	}
})

Deno.test('server returns unknown transfer id error to unexpected peer', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/hello.txt`, 'hello')
	const server = new Server(undefined, { host: '127.0.0.1', port: 1094, root })
	await server.listen()
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '0.0.0.0',
		port: 0,
	})
	const intruder = Deno.listenDatagram({
		transport: 'udp',
		hostname: '0.0.0.0',
		port: 0,
	})
	try {
		await socket.send(
			encodeRequestPacket(createRequest('GET', 'hello.txt')),
			{ transport: 'udp', hostname: '127.0.0.1', port: 1094 },
		)
		const [packet, addr] = await socket.receive()
		const remote = addr as Deno.NetAddr & { transport: 'udp' }
		void packet
		await intruder.send(new Uint8Array([0, 4, 0, 1]), {
			transport: 'udp',
			hostname: remote.hostname,
			port: remote.port,
		})
		const [errorPacket] = await intruder.receive()
		assertEquals(
			new DataView(
				errorPacket.buffer,
				errorPacket.byteOffset,
				errorPacket.byteLength,
			).getUint16(2),
			TFTPErrorCode.UNKNOWN_TRANSFER_ID,
		)
	} finally {
		socket.close()
		intruder.close()
		await server.close()
	}
})

Deno.test('server ignores or errors on forged invalid opcode to listening port', async () => {
	const server = new Server(undefined, { host: '127.0.0.1', port: 1102 })
	await server.listen()
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '0.0.0.0',
		port: 0,
	})
	try {
		await socket.send(
			new Uint8Array([0, 99, 106, 117, 110, 107, 0]),
			{ transport: 'udp', hostname: '127.0.0.1', port: 1102 },
		)
		const reply = await maybeReceiveDatagram(socket, 500)
		if (!reply) return
		const [packet] = reply
		const error = decodeErrorPacket(packet)
		assertEquals(error.code, TFTPErrorCode.ILLEGAL_OPERATION)
	} finally {
		socket.close()
		await server.close()
	}
})

Deno.test('server rejects forged ACK to listening port with illegal operation', async () => {
	const server = new Server(undefined, { host: '127.0.0.1', port: 1103 })
	await server.listen()
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '0.0.0.0',
		port: 0,
	})
	try {
		await socket.send(
			encodeAckPacket(1),
			{ transport: 'udp', hostname: '127.0.0.1', port: 1103 },
		)
		const [packet] = await receiveDatagram(socket)
		const error = decodeErrorPacket(packet)
		assertEquals(error.code, TFTPErrorCode.ILLEGAL_OPERATION)
	} finally {
		socket.close()
		await server.close()
	}
})

Deno.test('server rejects forged DATA to listening port with illegal operation', async () => {
	const server = new Server(undefined, { host: '127.0.0.1', port: 1104 })
	await server.listen()
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '0.0.0.0',
		port: 0,
	})
	try {
		await socket.send(
			encodeDataPacket(1, new Uint8Array([1, 2, 3])),
			{ transport: 'udp', hostname: '127.0.0.1', port: 1104 },
		)
		const [packet] = await receiveDatagram(socket)
		const error = decodeErrorPacket(packet)
		assertEquals(error.code, TFTPErrorCode.ILLEGAL_OPERATION)
	} finally {
		socket.close()
		await server.close()
	}
})

Deno.test('server ignores short malformed packets without crashing accept loop', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/hello.txt`, 'hello')
	const server = new Server(undefined, { host: '127.0.0.1', port: 1106, root })
	await server.listen()
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '0.0.0.0',
		port: 0,
	})
	try {
		await socket.send(
			new Uint8Array([0]),
			{ transport: 'udp', hostname: '127.0.0.1', port: 1106 },
		)
		const maybeError = await maybeReceiveDatagram(socket, 200)
		if (maybeError) {
			const [packet] = maybeError
			assertEquals(
				decodeErrorPacket(packet).code,
				TFTPErrorCode.ILLEGAL_OPERATION,
			)
		}

		await socket.send(
			encodeRequestPacket(createRequest('GET', 'hello.txt')),
			{ transport: 'udp', hostname: '127.0.0.1', port: 1106 },
		)
		const [packet] = await receiveDatagram(socket)
		assertEquals(
			new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
				.getUint16(0),
			3,
		)
	} finally {
		socket.close()
		await server.close()
	}
})

Deno.test('server OACK only includes options requested by the client', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/hello.txt`, 'hello')
	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 1107,
		root,
		blockSize: 1024,
		windowSize: 8,
	})
	await server.listen()
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '0.0.0.0',
		port: 0,
	})
	try {
		await socket.send(
			encodeRequestPacket(createRequest('GET', 'hello.txt', {
				options: { tsize: 0 },
			})),
			{ transport: 'udp', hostname: '127.0.0.1', port: 1107 },
		)
		const [packet, addr] = await receiveDatagram(socket)
		const remote = addr as UdpAddr
		const oack = decodeOptionsAckPacket(packet)
		assertEquals(oack.options.tsize, 5)
		assertEquals(oack.options.blksize, undefined)
		assertEquals(oack.options.windowsize, undefined)
		assertEquals(oack.options.timeout, undefined)

		await socket.send(encodeAckPacket(0), toSendAddr(remote))
		const [dataPacket] = await receiveDatagram(socket)
		assertEquals(
			decodeDataPacket(dataPacket).data,
			new TextEncoder().encode('hello'),
		)
	} finally {
		socket.close()
		await server.close()
	}
})

Deno.test('server omits tsize from netascii RRQ OACK', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/hello.txt`, 'hello\n')
	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 1109,
		root,
	})
	await server.listen()
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '0.0.0.0',
		port: 0,
	})
	try {
		await socket.send(
			encodeRequestPacket(createRequest('GET', 'hello.txt', {
				mode: 'netascii',
				options: { tsize: 0 },
			})),
			{ transport: 'udp', hostname: '127.0.0.1', port: 1109 },
		)
		const [packet, addr] = await receiveDatagram(socket)
		const remote = addr as UdpAddr
		const oack = decodeOptionsAckPacket(packet)
		assertEquals(oack.options.tsize, undefined)

		await socket.send(encodeAckPacket(0), toSendAddr(remote))
		const [dataPacket] = await receiveDatagram(socket)
		assertEquals(
			new TextDecoder().decode(decodeDataPacket(dataPacket).data),
			'hello\r\n',
		)
	} finally {
		socket.close()
		await server.close()
	}
})

Deno.test('server rejects malformed RRQ missing mode terminator', async () => {
	const server = new Server(undefined, { host: '127.0.0.1', port: 1113 })
	await server.listen()
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '0.0.0.0',
		port: 0,
	})
	try {
		await socket.send(
			new Uint8Array([0, 1, 102, 111, 111, 0, 111, 99, 116, 101, 116]),
			{ transport: 'udp', hostname: '127.0.0.1', port: 1113 },
		)
		const [packet] = await receiveDatagram(socket)
		const error = decodeErrorPacket(packet)
		assertEquals(error.code, TFTPErrorCode.ILLEGAL_OPERATION)
	} finally {
		socket.close()
		await server.close()
	}
})

Deno.test('server rejects malformed RRQ missing transfer mode', async () => {
	const server = new Server(undefined, { host: '127.0.0.1', port: 1114 })
	await server.listen()
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '0.0.0.0',
		port: 0,
	})
	try {
		await socket.send(
			new Uint8Array([0, 1, 102, 111, 111, 0]),
			{ transport: 'udp', hostname: '127.0.0.1', port: 1114 },
		)
		const [packet] = await receiveDatagram(socket)
		const error = decodeErrorPacket(packet)
		assertEquals(error.code, TFTPErrorCode.ILLEGAL_OPERATION)
	} finally {
		socket.close()
		await server.close()
	}
})

Deno.test('client and server can transfer windowed PUT data', async () => {
	const root = await Deno.makeTempDir()
	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 1095,
		root,
		allowCreateDir: true,
		blockSize: 1024,
		windowSize: 4,
	})
	await server.listen()
	try {
		const client = new Client({
			host: '127.0.0.1',
			port: 1095,
			blockSize: 1024,
			windowSize: 4,
		})
		const payload = 'upload-'.repeat(400)
		await client.put(
			'dir/file.txt',
			streamFromBytes(new TextEncoder().encode(payload)),
		)
		assertEquals(await Deno.readTextFile(`${root}/dir/file.txt`), payload)
	} finally {
		await server.close()
	}
})

Deno.test('client PUT advances after partial window ACK', async () => {
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '127.0.0.1',
		port: 1096,
	})
	try {
		const payload = new TextEncoder().encode('x'.repeat(39))
		const client = new Client({
			host: '127.0.0.1',
			port: 1096,
			blockSize: 8,
			windowSize: 4,
		})

		const putPromise = client.put('partial.txt', streamFromBytes(payload))

		const [requestPacket, addr] = await receiveDatagram(socket)
		const remote = addr as UdpAddr
		const request = decodeRequestPacket(requestPacket)
		assertEquals(request.method, 'PUT')
		assertEquals(request.options.blksize, 8)
		assertEquals(request.options.windowsize, 4)

		await socket.send(
			encodeOptionsAckPacket({
				blksize: 8,
				windowsize: 4,
				timeout: 3,
				tsize: payload.length,
			}),
			toSendAddr(remote),
		)

		const firstWindow = await receiveDataBlocks(socket, remote, 4, 8)
		assertEquals(firstWindow, [1, 2, 3, 4])

		await socket.send(encodeAckPacket(2), toSendAddr(remote))

		const secondWindow = await receiveDataBlocks(socket, remote, 3, 8)
		assertEquals(secondWindow, [3, 4, 5])

		await socket.send(encodeAckPacket(5), toSendAddr(remote))
		await putPromise
	} finally {
		socket.close()
	}
})

Deno.test('client and server handle block rollover for PUT data', async () => {
	const root = await Deno.makeTempDir()
	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 1105,
		root,
		blockSize: 8,
		windowSize: 1,
	})
	await server.listen()
	try {
		const client = new Client({
			host: '127.0.0.1',
			port: 1105,
			blockSize: 8,
			windowSize: 1,
		})
		const payload = new Uint8Array(8 * 65536)
		for (let index = 0; index < payload.length; index++) {
			payload[index] = index % 251
		}
		await client.put('rollover.bin', streamFromBytes(payload))
		const stored = await Deno.readFile(`${root}/rollover.bin`)
		assertEquals(stored.length, payload.length)
		assertEquals(stored, payload)
	} finally {
		await server.close()
	}
})

Deno.test('server ignores duplicate old ACK after partial window ACK', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/partial.txt`, 'x'.repeat(39))
	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 1097,
		root,
		blockSize: 8,
		windowSize: 4,
	})
	await server.listen()
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '0.0.0.0',
		port: 0,
	})
	try {
		await socket.send(
			encodeRequestPacket(createRequest('GET', 'partial.txt', {
				options: { blksize: 8, windowsize: 4 },
			})),
			{ transport: 'udp', hostname: '127.0.0.1', port: 1097 },
		)

		const [oackPacket, addr] = await receiveDatagram(socket)
		const remote = addr as UdpAddr
		const oack = decodeOptionsAckPacket(oackPacket)
		assertEquals(oack.options.blksize, 8)
		assertEquals(oack.options.windowsize, 4)

		await socket.send(encodeAckPacket(0), toSendAddr(remote))

		const firstWindow = await receiveDataBlocks(socket, remote, 4, 8)
		assertEquals(firstWindow, [1, 2, 3, 4])

		await socket.send(encodeAckPacket(2), toSendAddr(remote))
		await socket.send(encodeAckPacket(2), toSendAddr(remote))

		const secondWindow = await receiveDataBlocks(socket, remote, 3, 8)
		assertEquals(secondWindow, [3, 4, 5])
		assertEquals(await maybeReceiveDatagram(socket, 100), undefined)

		await socket.send(encodeAckPacket(5), toSendAddr(remote))
	} finally {
		socket.close()
		await server.close()
	}
})

Deno.test('server resends tail of GET window after partial ACK and timeout', async () => {
	const root = await Deno.makeTempDir()
	await Deno.writeTextFile(`${root}/rfc7440.txt`, 'x'.repeat(39))
	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 1110,
		root,
		blockSize: 8,
		windowSize: 4,
		timeout: 200,
	})
	await server.listen()
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '0.0.0.0',
		port: 0,
	})
	try {
		await socket.send(
			encodeRequestPacket(createRequest('GET', 'rfc7440.txt', {
				options: { blksize: 8, windowsize: 4 },
			})),
			{ transport: 'udp', hostname: '127.0.0.1', port: 1110 },
		)

		const [oackPacket, addr] = await receiveDatagram(socket)
		const remote = addr as UdpAddr
		void decodeOptionsAckPacket(oackPacket)
		await socket.send(encodeAckPacket(0), toSendAddr(remote))

		assertEquals(await receiveDataBlocks(socket, remote, 4, 8), [1, 2, 3, 4])
		await socket.send(encodeAckPacket(2), toSendAddr(remote))

		assertEquals(await receiveDataBlocks(socket, remote, 3, 8), [3, 4, 5])
		assertEquals(await receiveDataBlocks(socket, remote, 3, 8, 1500), [
			3,
			4,
			5,
		])
		await socket.send(encodeAckPacket(5), toSendAddr(remote))
	} finally {
		socket.close()
		await server.close()
	}
})

Deno.test('server ACKs last good block for duplicate and out-of-order PUT data', async () => {
	const root = await Deno.makeTempDir()
	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 1098,
		root,
		blockSize: 8,
		windowSize: 4,
	})
	await server.listen()
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '0.0.0.0',
		port: 0,
	})
	try {
		await socket.send(
			encodeRequestPacket(createRequest('PUT', 'dup.txt', {
				options: { blksize: 8, windowsize: 4, tsize: 12 },
			})),
			{ transport: 'udp', hostname: '127.0.0.1', port: 1098 },
		)

		const [oackPacket, addr] = await receiveDatagram(socket)
		const remote = addr as UdpAddr
		const oack = decodeOptionsAckPacket(oackPacket)
		assertEquals(oack.options.blksize, 8)

		await socket.send(
			encodeDataPacket(1, new TextEncoder().encode('abcdefgh')),
			toSendAddr(remote),
		)
		await socket.send(
			encodeDataPacket(1, new TextEncoder().encode('abcdefgh')),
			toSendAddr(remote),
		)
		assertEquals(decodeAckPacket((await receiveDatagram(socket))[0]).block, 1)

		await socket.send(
			encodeDataPacket(3, new TextEncoder().encode('xxxx')),
			toSendAddr(remote),
		)
		assertEquals(decodeAckPacket((await receiveDatagram(socket))[0]).block, 1)

		await socket.send(
			encodeDataPacket(2, new TextEncoder().encode('ijkl')),
			toSendAddr(remote),
		)
		assertEquals(decodeAckPacket((await receiveDatagram(socket))[0]).block, 2)

		assertEquals(await Deno.readTextFile(`${root}/dup.txt`), 'abcdefghijkl')
	} finally {
		socket.close()
		await server.close()
	}
})

Deno.test('server re-ACKs last committed PUT block after hole in window', async () => {
	const root = await Deno.makeTempDir()
	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 1111,
		root,
		blockSize: 8,
		windowSize: 4,
	})
	await server.listen()
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '0.0.0.0',
		port: 0,
	})
	try {
		await socket.send(
			encodeRequestPacket(createRequest('PUT', 'window.txt', {
				options: { blksize: 8, windowsize: 4, tsize: 28 },
			})),
			{ transport: 'udp', hostname: '127.0.0.1', port: 1111 },
		)

		const [oackPacket, addr] = await receiveDatagram(socket)
		const remote = addr as UdpAddr
		void decodeOptionsAckPacket(oackPacket)

		await socket.send(
			encodeDataPacket(1, new TextEncoder().encode('aaaaaaaa')),
			toSendAddr(remote),
		)
		await socket.send(
			encodeDataPacket(2, new TextEncoder().encode('bbbbbbbb')),
			toSendAddr(remote),
		)
		await socket.send(
			encodeDataPacket(4, new TextEncoder().encode('dddd')),
			toSendAddr(remote),
		)
		assertEquals(decodeAckPacket((await receiveDatagram(socket))[0]).block, 2)

		await socket.send(
			encodeDataPacket(3, new TextEncoder().encode('cccccccc')),
			toSendAddr(remote),
		)
		await socket.send(
			encodeDataPacket(4, new TextEncoder().encode('dddd')),
			toSendAddr(remote),
		)
		assertEquals(decodeAckPacket((await receiveDatagram(socket))[0]).block, 4)
		assertEquals(
			await Deno.readTextFile(`${root}/window.txt`),
			'aaaaaaaabbbbbbbbccccccccdddd',
		)
	} finally {
		socket.close()
		await server.close()
	}
})

Deno.test('server resends final ACK when last WRQ data block is retransmitted', async () => {
	const root = await Deno.makeTempDir()
	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 1108,
		root,
		blockSize: 8,
		windowSize: 1,
		timeout: 200,
	})
	await server.listen()
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '0.0.0.0',
		port: 0,
	})
	try {
		await socket.send(
			encodeRequestPacket(createRequest('PUT', 'late.txt', {
				options: { blksize: 8, windowsize: 1, tsize: 5 },
			})),
			{ transport: 'udp', hostname: '127.0.0.1', port: 1108 },
		)

		const [oackPacket, addr] = await receiveDatagram(socket)
		const remote = addr as UdpAddr
		void decodeOptionsAckPacket(oackPacket)

		const finalData = encodeDataPacket(1, new TextEncoder().encode('hello'))
		await socket.send(finalData, toSendAddr(remote))
		assertEquals(decodeAckPacket((await receiveDatagram(socket))[0]).block, 1)

		await socket.send(finalData, toSendAddr(remote))
		assertEquals(decodeAckPacket((await receiveDatagram(socket))[0]).block, 1)
		assertEquals(await Deno.readTextFile(`${root}/late.txt`), 'hello')
	} finally {
		socket.close()
		await server.close()
	}
})

Deno.test('server rejects PUT body larger than declared tsize', async () => {
	const root = await Deno.makeTempDir()
	const server = new Server(undefined, {
		host: '127.0.0.1',
		port: 1099,
		root,
		blockSize: 8,
		windowSize: 4,
	})
	await server.listen()
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '0.0.0.0',
		port: 0,
	})
	try {
		await socket.send(
			encodeRequestPacket(createRequest('PUT', 'size.txt', {
				options: { blksize: 8, windowsize: 4, tsize: 4 },
			})),
			{ transport: 'udp', hostname: '127.0.0.1', port: 1099 },
		)

		const [oackPacket, addr] = await receiveDatagram(socket)
		const remote = addr as UdpAddr
		void decodeOptionsAckPacket(oackPacket)

		await socket.send(
			encodeDataPacket(1, new TextEncoder().encode('abcdefgh')),
			toSendAddr(remote),
		)

		const [errorPacket] = await receiveDatagram(socket)
		const error = decodeErrorPacket(errorPacket)
		assertEquals(error.code, TFTPErrorCode.NOT_DEFINED)
		assertEquals(error.message, 'Transfer size mismatch')
		await assertRejects(() => Deno.stat(`${root}/size.txt`))
	} finally {
		socket.close()
		await server.close()
	}
})

Deno.test('client ACKs last good block for duplicate and out-of-order GET data', async () => {
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '127.0.0.1',
		port: 1100,
	})
	try {
		const client = new Client({
			host: '127.0.0.1',
			port: 1100,
			blockSize: 8,
			windowSize: 4,
		})

		const getPromise = client.get('dup.txt')

		const [requestPacket, addr] = await receiveDatagram(socket)
		const remote = addr as UdpAddr
		const request = decodeRequestPacket(requestPacket)
		assertEquals(request.method, 'GET')

		await socket.send(
			encodeOptionsAckPacket({
				blksize: 8,
				windowsize: 4,
				timeout: 3,
				tsize: 12,
			}),
			toSendAddr(remote),
		)
		assertEquals(decodeAckPacket((await receiveDatagram(socket))[0]).block, 0)

		await socket.send(
			encodeDataPacket(1, new TextEncoder().encode('abcdefgh')),
			toSendAddr(remote),
		)
		await socket.send(
			encodeDataPacket(1, new TextEncoder().encode('abcdefgh')),
			toSendAddr(remote),
		)
		assertEquals(decodeAckPacket((await receiveDatagram(socket))[0]).block, 1)

		await socket.send(
			encodeDataPacket(3, new TextEncoder().encode('xxxx')),
			toSendAddr(remote),
		)
		assertEquals(decodeAckPacket((await receiveDatagram(socket))[0]).block, 1)

		await socket.send(
			encodeDataPacket(2, new TextEncoder().encode('ijkl')),
			toSendAddr(remote),
		)
		assertEquals(decodeAckPacket((await receiveDatagram(socket))[0]).block, 2)

		const response = await getPromise
		assertEquals(
			new TextDecoder().decode(await streamToBytes(response.body)),
			'abcdefghijkl',
		)
	} finally {
		socket.close()
	}
})

Deno.test('client re-ACKs old GET block after dropped tail of window', async () => {
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '127.0.0.1',
		port: 1112,
	})
	try {
		const client = new Client({
			host: '127.0.0.1',
			port: 1112,
			blockSize: 8,
			windowSize: 4,
			timeout: 200,
			retries: 2,
		})

		const getPromise = client.get('drop.txt')

		const [requestPacket, addr] = await receiveDatagram(socket)
		const remote = addr as UdpAddr
		void decodeRequestPacket(requestPacket)

		await socket.send(
			encodeOptionsAckPacket({
				blksize: 8,
				windowsize: 4,
				timeout: 1,
				tsize: 28,
			}),
			toSendAddr(remote),
		)
		assertEquals(decodeAckPacket((await receiveDatagram(socket))[0]).block, 0)

		await socket.send(
			encodeDataPacket(1, new TextEncoder().encode('aaaaaaaa')),
			toSendAddr(remote),
		)
		await socket.send(
			encodeDataPacket(2, new TextEncoder().encode('bbbbbbbb')),
			toSendAddr(remote),
		)
		await socket.send(
			encodeDataPacket(3, new TextEncoder().encode('cccccccc')),
			toSendAddr(remote),
		)
		await socket.send(
			encodeDataPacket(5, new TextEncoder().encode('eeee')),
			toSendAddr(remote),
		)
		assertEquals(
			decodeAckPacket((await receiveDatagram(socket, 1500))[0]).block,
			3,
		)

		await socket.send(
			encodeDataPacket(4, new TextEncoder().encode('dddddddd')),
			toSendAddr(remote),
		)
		assertEquals(
			decodeAckPacket((await receiveDatagram(socket, 1500))[0]).block,
			4,
		)

		await socket.send(
			encodeDataPacket(5, new TextEncoder().encode('eeee')),
			toSendAddr(remote),
		)
		assertEquals(
			decodeAckPacket((await receiveDatagram(socket, 1500))[0]).block,
			5,
		)

		const response = await getPromise
		assertEquals(
			new TextDecoder().decode(await streamToBytes(response.body)),
			'aaaaaaaabbbbbbbbccccccccddddddddeeee',
		)
	} finally {
		socket.close()
	}
})

Deno.test('client ignores out-of-order GET data before first valid block', async () => {
	const socket = Deno.listenDatagram({
		transport: 'udp',
		hostname: '127.0.0.1',
		port: 1101,
	})
	try {
		const client = new Client({
			host: '127.0.0.1',
			port: 1101,
			blockSize: 8,
			windowSize: 4,
		})

		const getPromise = client.get('order.txt')

		const [requestPacket, addr] = await receiveDatagram(socket)
		const remote = addr as UdpAddr
		void decodeRequestPacket(requestPacket)

		await socket.send(
			encodeOptionsAckPacket({
				blksize: 8,
				windowsize: 4,
				timeout: 3,
				tsize: 7,
			}),
			toSendAddr(remote),
		)
		assertEquals(decodeAckPacket((await receiveDatagram(socket))[0]).block, 0)

		await socket.send(
			encodeDataPacket(2, new TextEncoder().encode('ignored')),
			toSendAddr(remote),
		)
		assertEquals(decodeAckPacket((await receiveDatagram(socket))[0]).block, 0)

		await socket.send(
			encodeDataPacket(1, new TextEncoder().encode('abcdefg')),
			toSendAddr(remote),
		)
		assertEquals(decodeAckPacket((await receiveDatagram(socket))[0]).block, 1)

		const response = await getPromise
		assertEquals(
			new TextDecoder().decode(await streamToBytes(response.body)),
			'abcdefg',
		)
	} finally {
		socket.close()
	}
})

async function receiveDataBlocks(
	socket: Deno.DatagramConn,
	remote: UdpAddr,
	count: number,
	blockSize: number,
	timeoutMs = 1000,
): Promise<number[]> {
	const blocks: number[] = []
	for (let index = 0; index < count; index++) {
		const [packet, addr] = await receiveDatagram(socket, timeoutMs)
		assertEquals(addr, remote)
		blocks.push(decodeDataPacket(packet, blockSize).block)
	}
	return blocks
}

async function receiveDatagram(
	socket: Deno.DatagramConn,
	timeoutMs = 1000,
): Promise<[Uint8Array, Deno.Addr]> {
	const received = await maybeReceiveDatagram(socket, timeoutMs)
	if (!received) {
		throw new Error('Timed out waiting for datagram')
	}
	return received
}

async function maybeReceiveDatagram(
	socket: Deno.DatagramConn,
	timeoutMs = 1000,
): Promise<[Uint8Array, Deno.Addr] | undefined> {
	try {
		return await deadline(socket.receive(), timeoutMs)
	} catch (error) {
		if (error instanceof DOMException && error.name === 'TimeoutError') {
			return undefined
		}
		throw error
	}
}

async function streamToBytes(
	body?: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	if (!body) return new Uint8Array()
	const reader = body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		while (true) {
			const { value, done } = await reader.read()
			if (done) break
			if (!value) continue
			chunks.push(value)
			total += value.length
		}
	} finally {
		reader.releaseLock()
	}

	const out = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		out.set(chunk, offset)
		offset += chunk.length
	}
	return out
}

function toSendAddr(addr: UdpAddr): Deno.NetAddr {
	return {
		transport: 'udp',
		hostname: addr.hostname,
		port: addr.port,
	}
}
