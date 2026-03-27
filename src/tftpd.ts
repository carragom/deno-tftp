import { Command } from '@cliffy/command'

import { Server } from './server.ts'

async function main() {
	await new Command()
		.name('tftpd')
		.description('Pre-1.0 TFTP server')
		.option('--host <host:string>', 'Bind host', { default: '0.0.0.0' })
		.option('--port <port:number>', 'Bind port', { default: 69 })
		.option('--root <root:string>', 'Filesystem root')
		.option('--deny-get', 'Deny GET requests')
		.option('--deny-put', 'Deny PUT requests')
		.option('--allow-overwrite', 'Allow overwriting files')
		.option('--allow-create-file', 'Allow creating files', { default: true })
		.option('--allow-create-dir', 'Allow recursively creating directories')
		.option('--max-put-size <bytes:number>', 'Maximum PUT size')
		.action(async (options: Record<string, unknown>) => {
			const server = new Server({
				host: options.host as string | undefined,
				port: options.port as number | undefined,
				root: options.root as string | undefined,
				denyGET: options.denyGet as boolean | undefined,
				denyPUT: options.denyPut as boolean | undefined,
				allowOverwrite: options.allowOverwrite as boolean | undefined,
				allowCreateFile: options.allowCreateFile as boolean | undefined,
				allowCreateDir: options.allowCreateDir as boolean | undefined,
				maxPutSize: options.maxPutSize as number | undefined,
			})
			await server.listen()
			console.log(`tftpd listening on ${server.host}:${server.port}`)
			await new Promise(() => undefined)
		})
		.parse(Deno.args)
}

if (import.meta.main) {
	main()
}
