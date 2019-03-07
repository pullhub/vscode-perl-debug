import {spawn} from 'child_process';
import { Readable, Writable } from 'stream';
import { EventEmitter } from 'events';
import { DebugSession } from './session';
import { LaunchRequestArguments } from './perlDebug';

export class LocalSession extends EventEmitter implements DebugSession {
	public stdin: Writable;
	public stdout: Readable;
	public stderr: Readable;
	public kill: Function;
	public title: Function;
	public dump: Function;
	public port: Number | null;

	constructor(launchArgs: LaunchRequestArguments) {

		super();

		const perlCommand = launchArgs.exec || 'perl';
		const programArguments = launchArgs.args || [];

		const commandArgs = (launchArgs.execArgs || []).concat([ '-d', launchArgs.program /*, '-emacs'*/], programArguments);

		const spawnOptions = {
			detached: true,
			cwd: launchArgs.root || undefined,
			env: {
				COLUMNS: 80,
				LINES: 25,
				TERM: 'dumb',
				...launchArgs.env,
			},
		};

		const session = spawn(perlCommand, commandArgs, spawnOptions);
		this.stdin = session.stdin;
		this.stdout = session.stdout;
		this.stderr = session.stderr;
		this.kill = () => {
			this.removeAllListeners();
			session.kill();
		};
		this.title = () => `${perlCommand} ${commandArgs.join(' ')}`;
		this.dump = () => `spawn(${perlCommand}, ${JSON.stringify(commandArgs)}, ${JSON.stringify(spawnOptions)});`;
	}
}
