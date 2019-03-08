'use strict';

import * as Net from 'net';
import * as vscode from 'vscode';
import * as path from 'path';
import {
	WorkspaceFolder, DebugConfiguration, ProviderResult,
	CancellationToken
} from 'vscode';
import { PerlDebugSession } from './perlDebug';

/*
 * Set the following compile time flag to true if the
 * debug adapter should run inside the extension host.
 * Please note: the test suite does not (yet) work in this mode.
 */
const EMBED_DEBUG_ADAPTER = true;

let perlDebugOutputChannel: vscode.OutputChannel | undefined;
let streamCatcherOutputChannel: vscode.OutputChannel | undefined;

function handlePerlDebugEvent(
	event: vscode.DebugSessionCustomEvent
) {

	if (!perlDebugOutputChannel) {

		perlDebugOutputChannel = vscode.window.createOutputChannel(
			'Perl Debug Log'
		);

		perlDebugOutputChannel.show(true);

	}

	perlDebugOutputChannel.appendLine(
		JSON.stringify([
			new Date().toISOString(),
			event.event,
			...event.body,
		])
	);

}

function handleStreamCatcherEvent(
	event: vscode.DebugSessionCustomEvent
) {

	if (!streamCatcherOutputChannel) {

		streamCatcherOutputChannel = vscode.window.createOutputChannel(
			'Perl Debug RAW'
		);

		streamCatcherOutputChannel.show(true);

	}

	streamCatcherOutputChannel.appendLine(
		JSON.stringify([
			new Date().toISOString(),
			event.event,
			...event.body,
		])
	);

}

function handleAttachableEvent(
	event: vscode.DebugSessionCustomEvent
) {

	const config: vscode.DebugConfiguration = {
		...vscode.debug.activeDebugSession.configuration,
		type: 'perl',
		request: 'attach',
		name: `auto-attach ${event.body.port}`,
		port: event.body.port,
		console: "none",
		debugServer: null,
	};

	vscode.debug.startDebugging(
		undefined,
		config
	).then((...x) => {
		vscode.debug.activeDebugConsole.appendLine(
			`Child session via ${event.body.address}:${event.body.port}`
		);
	});

}

function handleCustomEvent(event: vscode.DebugSessionCustomEvent) {

	if (event.session.type !== 'perl') {
		return;
	}

	switch (event.event) {
		case 'perl-debug.streamcatcher.write':
		case 'perl-debug.streamcatcher.data':
			handleStreamCatcherEvent(event);
			break;
		case 'perl-debug.attachable.listening':
			handleAttachableEvent(event);
			break;
		case 'perl-debug.debug':
			handlePerlDebugEvent(event);
			break;
		case 'perl-debug.streamcatcher.clear':
			if (streamCatcherOutputChannel) {
				streamCatcherOutputChannel.clear();
			}
			break;
		default:
			return;
	}

}

export function activate(context: vscode.ExtensionContext) {

	const debugProvider = new PerlDebugConfigurationProvider();

	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider(
			'perl', debugProvider
		)
	);

	context.subscriptions.push(
		vscode.debug.onDidReceiveDebugSessionCustomEvent(
			handleCustomEvent
		)
	);

	if (EMBED_DEBUG_ADAPTER) {
		const factory = new PerlDebugAdapterDescriptorFactory();
		context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('perl', factory));
		context.subscriptions.push(factory);
	}

}

export function deactivate(): Thenable<void> {
	return;
}

class PerlDebugConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is
	 * being launched, e.g. add all missing attributes to the debug
	 * configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

		const editor = vscode.window.activeTextEditor;

		if (!config.request && editor.document.languageId === 'perl') {

			const defaultConfig = vscode.extensions.getExtension(
				"mortenhenriksen.perl-debug"
			)
			.packageJSON
			.contributes
			.debuggers[0]
			.initialConfigurations[0];

			return defaultConfig;

		} else if (!config.request) {

			// Not trying to debug perl?
			return undefined;
		}

		// TODO(bh): Given that `package.json` specifies various default
		// values for the launch configuration, perhaps this should start
		// with the defaults, merge in the actually specified options,
		// and then make final adjustments? Otherwise there is a chance
		// default values end up being ignored.

		if (config.port && !config.console) {
			config.console = 'remote';
		}

		if (!config.sessions) {
			config.sessions = 'single';
		}

		if (!config.console) {
			config.console = 'integratedTerminal';
		}

		if (config.autoAttachChildren === undefined) {
			config.autoAttachChildren = true;
		}

		// map config.inc as leading -I execArgs
		config.execArgs = (config.inc || [])
			.map(d => `-I${d}`)
			.concat(config.execArgs || []);

		return config;
	}
}


class PerlDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {

	private server?: Net.Server;

	createDebugAdapterDescriptor(
		session: vscode.DebugSession,
		executable: vscode.DebugAdapterExecutable | undefined
	): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {

		if (!this.server) {
			// start listening on a random port
			this.server = Net.createServer(socket => {
				const session = new PerlDebugSession();
				session.setRunAsServer(true);
				session.start(<NodeJS.ReadableStream>socket, socket);
			}).listen(0);
		}

		// make VS Code connect to debug server
		return new vscode.DebugAdapterServer(this.server.address().port);
	}

	dispose() {
		if (this.server) {
			this.server.close();
		}
	}
}
