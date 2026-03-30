import { Command } from '@cliffy/command'

import type { ServerLogEntry, ServerLogger, ServerLogLevel } from './server.ts'
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
		.option(
			'--log-level <level:string>',
			'Log threshold: error, warn, or info',
			{ default: 'warn' },
		)
		.action(async (options: Record<string, unknown>) => {
			const logLevel = parseLogLevel(options.logLevel as string | undefined)
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
				logger: createServerLogger(logLevel),
			})
			await server.listen()
			await new Promise(() => undefined)
		})
		.parse(Deno.args)
}

function createServerLogger(threshold: ServerLogLevel): ServerLogger {
	return (entry) => {
		if (!shouldLog(entry.level, threshold)) return
		const line = formatLogEntry(entry)
		const writer = entry.level === 'info' ? console.log : console.error
		writer(line)
	}
}

function parseLogLevel(value: string | undefined): ServerLogLevel {
	switch (value) {
		case undefined:
		case 'warn':
		case 'info':
		case 'error':
			return value ?? 'warn'
		default:
			throw new Error(
				`Invalid --log-level: ${value}. Expected error, warn, or info.`,
			)
	}
}

function shouldLog(
	level: ServerLogLevel,
	threshold: ServerLogLevel,
): boolean {
	return logLevelRank(level) <= logLevelRank(threshold)
}

function logLevelRank(level: ServerLogLevel): number {
	switch (level) {
		case 'error':
			return 0
		case 'warn':
			return 1
		case 'info':
			return 2
	}
}

function formatLogEntry(entry: ServerLogEntry): string {
	const fields = [
		['level', entry.level],
		['event', entry.event],
		['source', entry.source],
		entry.method ? ['method', entry.method] : undefined,
		entry.path ? ['path', entry.path] : undefined,
		entry.remote
			? ['remote', `${entry.remote.address}:${entry.remote.port}`]
			: undefined,
		entry.local
			? ['local', `${entry.local.address}:${entry.local.port}`]
			: undefined,
		entry.bytes !== undefined ? ['bytes', String(entry.bytes)] : undefined,
		entry.error ? ['code', String(entry.error.code)] : undefined,
		entry.error?.message ? ['message', entry.error.message] : undefined,
		!entry.error && entry.message ? ['message', entry.message] : undefined,
	].filter((field): field is [string, string] => field !== undefined)

	return fields.map(([key, value]) => `${key}=${quoteLogValue(value)}`).join(
		' ',
	)
}

function quoteLogValue(value: string): string {
	return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : JSON.stringify(value)
}

if (import.meta.main) {
	main()
}
