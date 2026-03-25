import { Command } from '@cliffy/command'

import { Client } from './client.ts'
import { parseTFTPUri } from './utils.ts'

async function main() {
	await new Command()
		.name('tftp')
		.description('Pre-1.0 TFTP client')
		.command(
			'get <uri:string> [output:string]',
			new Command()
				.description('Fetch a file from a TFTP server')
				.action(async function (this: Command, ...args: unknown[]) {
					const [uri, output = '-'] = args as [string, string?]
					const parsed = parseTFTPUri(uri)
					const client = new Client({
						host: parsed.host,
						port: parsed.port ?? 69,
					})
					const response = await client.get(parsed.path, {
						mode: parsed.mode,
					})
					const target = output === '-'
						? Deno.stdout.writable
						: (await Deno.open(output, {
							create: true,
							write: true,
							truncate: true,
						})).writable
					await response.body?.pipeTo(target)
				}),
		)
		.command(
			'put <uri:string> [input:string]',
			new Command()
				.description('Upload a file to a TFTP server')
				.action(async function (this: Command, ...args: unknown[]) {
					const [uri, input = '-'] = args as [string, string?]
					const parsed = parseTFTPUri(uri)
					const client = new Client({
						host: parsed.host,
						port: parsed.port ?? 69,
					})
					const body = input === '-'
						? Deno.stdin.readable
						: (await Deno.open(input, { read: true })).readable
					await client.put(parsed.path, body, { mode: parsed.mode })
				}),
		)
		.parse(Deno.args)
}

if (import.meta.main) {
	main()
}
