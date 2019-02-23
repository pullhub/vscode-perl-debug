/// <reference types="node" />

import {
	Logger, logger,
	DebugSession, LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent, Event,
	ContinuedEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint, Variable,
	LoadedSourceEvent
} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import {readFileSync} from 'fs';
import {basename, dirname, join} from 'path';
import {spawn, ChildProcess} from 'child_process';
const { Subject } = require('await-notify');
import { perlDebuggerConnection } from './adapter';
import { variableType, ParsedVariable, ParsedVariableScope, resolveVariable } from './variableParser';

/**
 * This interface should always match the schema found in the perl-debug extension manifest.
 */
export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** Perl binary */
	exec: string;
	/** Binary executable arguments */
	execArgs: string[],
	/** Workspace path */
	root: string,
	/** An absolute path to the program to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** List of includes */
	inc?: string[];
	/** List of program arguments */
	args?: string[];
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
	/** env variables when executing debugger */
	env?: {};
	/** port for debugger to listen for remote debuggers */
	port?,
	/** Where to launch the debug target */
	console?: string,
	/** Log raw I/O with debugger in output channel */
	debugRaw?: boolean,
	/** Attach to forked children */
	autoAttachChildren?: boolean,
	/** Automatically stop children after launch. If not specified, children do not stop. */
	stopChildrenOnEntry?: boolean;
}

export class PerlDebugSession extends LoggingDebugSession {
	private static THREAD_ID = 1;

	private _breakpointId = 1000;

	// This is the next line that will be 'executed'
	private __currentLine = 0;
	private get _currentLine() : number {
		return this.__currentLine;
    }
	private set _currentLine(line: number) {
		this.__currentLine = line;
	}

	private _breakPoints = new Map<string, DebugProtocol.Breakpoint[]>();
	private _functionBreakPoints: string[] = [];

	private _loadedSources = new Map<string, Source>();

	private _variableHandles = new Handles<string>();

	public dcSupportsRunInTerminal: boolean = false;

	private perlDebugger: perlDebuggerConnection;

	public constructor() {
		super('perl_debugger.log');

		this.perlDebugger = new perlDebuggerConnection();

		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);
	}

	private rootPath: string = '';

	private _configurationDone = new Subject();

   /* protected convertClientPathToDebugger(clientPath: string): string {
		return clientPath.replace(this.rootPath, '');
	}

    protected convertDebuggerPathToClient(debuggerPath: string): string {
		return join(this.rootPath, debuggerPath);
	}*/

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		this.dcSupportsRunInTerminal = !!args.supportsRunInTerminalRequest;

		this.perlDebugger.on('perl-debug.output', (text) => {
			this.sendEvent(new OutputEvent(`${text}\n`));
		});

		this.perlDebugger.on('perl-debug.exception', (res) => {
			// xxx: for now I need more info, code to go away...
			const [ error ] = res.errors;
			this.sendEvent(
				new OutputEvent(`${error.message}`, 'stderr')
			);
		});

		this.perlDebugger.on('perl-debug.termination', (x) => {
			this.sendEvent(new TerminatedEvent());
		});

		this.perlDebugger.on('perl-debug.close', (x) => {
			this.sendEvent(new TerminatedEvent());
		});

		this.perlDebugger.on('perl-debug.debug', (x) => {
			this.sendEvent(new Event('perl-debug.debug', x));
		});

		this.perlDebugger.on(
			'perl-debug.attachable.listening',
			(...x) => {
				this.sendEvent(
					new Event(
						'perl-debug.attachable.listening', ...x
						// {
						// 	port: address.port,
						// 	family: address.family,
						// 	address: address.address
						// }
					)
				);
			}
		);

		this.perlDebugger.initializeRequest()
			.then(() => {
				// This debug adapter implements the configurationDoneRequest.
				response.body.supportsConfigurationDoneRequest = true;

				// make VS Code to use 'evaluate' when hovering over source
				response.body.supportsEvaluateForHovers = true;

				// make VS Code to show a 'step back' button
				response.body.supportsStepBack = false;

				response.body.supportsFunctionBreakpoints = false;

				response.body.supportsLoadedSourcesRequest = true;

				this.sendResponse(response);

				// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
				// we request them early by sending an 'initializeRequest' to the frontend.
				// The frontend will end the configuration sequence by calling 'configurationDone' request.
				this.sendEvent(new InitializedEvent());
			});
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
		this.launchAndAttachRequest(response, args);
	}

	private async launchAndAttachRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {

		this.rootPath = args.root;

		const inc = args.inc && args.inc.length ? args.inc.map(directory => `-I${directory}`) : [];
		const execArgs = [].concat(args.execArgs || [], inc);
		const programArguments = args.args || [];

		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		await this._configurationDone.wait(1000);

		this.perlDebugger.removeAllListeners('perl-debug.streamcatcher.data');
		this.perlDebugger.removeAllListeners('perl-debug.streamcatcher.write');

		// FIXME(bh): Should only be done if this is a new main session.
		// Perhaps use a private launch config option to indicate if this
		// is a child session?
		this.sendEvent(new Event('perl-debug.streamcatcher.clear'));

		if (args.debugRaw) {
			this.perlDebugger.on('perl-debug.streamcatcher.data', (...x) => {
				this.sendEvent(new Event('perl-debug.streamcatcher.data', x));
			});

			this.perlDebugger.on('perl-debug.streamcatcher.write', (...x) => {
				this.sendEvent(new Event('perl-debug.streamcatcher.write', x));
			});
		}

		const launchResponse = await this.perlDebugger.launchRequest(
			args.program,
			args.root,
			execArgs,
			{
				exec: args.exec,
				args: programArguments,
				env: {
					PATH: process.env.PATH || '',
					// PERL5OPT: process.env.PERL5OPT || '',
					PERL5LIB: process.env.PERL5LIB || '',
					...args.env
				},
				port: args.port || undefined,
				console: args.console,
				autoAttachChildren: args.autoAttachChildren,

				// FIXME: figure out the split between LaunchOptions
				// stopChildrenOnEntry: args.stopChildrenOnEntry
			},
			// Needs a reference to the session for `runInTerminal`
			this
		);

		if (args.stopOnEntry) {
			if (launchResponse.ln) {
				this._currentLine = launchResponse.ln - 1;
			}
			this.sendResponse(response);

			// we stop on the first line
			this.sendEvent(new StoppedEvent("entry", PerlDebugSession.THREAD_ID));
		} else {
			// we just start to run until we hit a breakpoint or an exception
			this.continueRequest(<DebugProtocol.ContinueResponse>response, { threadId: PerlDebugSession.THREAD_ID });
		}

	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// TODO(bh): vscode actually shows the thread name in the user
		// interface during multi-session debugging, at least until
		// https://github.com/Microsoft/vscode/issues/69752 is addressed,
		// so it might be a good idea to set a better name here.

		// xxx: Not sure if this is sufficient to levarage multi cores?
		// return the default thread
		response.body = {
			threads: [
				new Thread(PerlDebugSession.THREAD_ID, "thread 1")
			]
		};
		this.sendResponse(response);
	}


/**
 * TODO
 *
 * if possible:
 *
 * * step out
 * * step back
 * * reverse continue
 * * data breakpoints (https://github.com/raix/vscode-perl-debug/issues/4)
 */

	/**
	 * Data breakpoints
	 */
	protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments) {
		response.success = false;
		this.sendResponse(response);
	}

	/**
	 * Data breakpoint info
	 */
	protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments) {
		response.success = false;
		this.sendResponse(response);
	}

	/**
	 * Reverse continue
	 */
	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments) : void {
		this.sendEvent(new OutputEvent(`ERR>Reverse continue not implemented\n\n`));

		this.sendResponse(response);
		// no more lines: stop at first line
		this._currentLine = 0;
		this.sendEvent(new StoppedEvent("entry", PerlDebugSession.THREAD_ID));
 	}

	/**
	 * Step back
	 */
	protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
		this.sendEvent(new OutputEvent(`ERR>Step back not implemented\n`));

		this.sendResponse(response);
		// no more lines: stop at first line
		this._currentLine = 0;
		this.sendEvent(new StoppedEvent("entry", PerlDebugSession.THREAD_ID));
	}






	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {

		if (this.perlDebugger.isRemote) {
			response.success = false;
			response.body = {
				error: {
					message: 'Cannot send SIGINT to debugger on remote system'
				}
			};
			this.sendResponse(response);

		} else {

			// Send SIGINT to the `perl -d` process on the local system.
			process.kill(this.perlDebugger.debuggerPid, 'SIGINT');
			this.sendResponse(response);

			// TODO(bh): It is not clear if we are supposed to also send a
			// `StoppedEvent` and if we are, what the logic for that ought
			// to be. Basically, whenever we see the `DB<N>` prompt from
			// the debugger we are most probably stopped. That's the same
			// for all protocol functions though, which suggests that ought
			// to be handled centrally someplace, and not individually for
			// each request. As it is, in any case, it does not seem to
			// make a difference in vscode whether send one here or not.

		}

	}




	private async setFunctionBreakPointsRequestAsync(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments): Promise<DebugProtocol.SetFunctionBreakpointsResponse> {
		const breakpoints: string[] = [];
		const newBreakpoints: string[] = args.breakpoints.map(bp => { return bp.name });
		const neoBreakpoints: DebugProtocol.FunctionBreakpoint[] = [];

		for (let i = 0; i < this._functionBreakPoints.length; i++) {
			const name = this._functionBreakPoints[i];
			if (newBreakpoints.indexOf(name) < 0) {
				this.sendEvent(new OutputEvent(`Remove ${name}\n`));
				await this.perlDebugger.request(`B ${name}`);
			}
		}

		for (let i = 0; i < args.breakpoints.length; i++) {
			const bp = args.breakpoints[i];
			if (this._functionBreakPoints.indexOf(bp.name) < 0) {
				breakpoints.push(bp.name);
				const res = await this.perlDebugger.request(`b ${bp.name}`);

				this.sendEvent(new OutputEvent(`Add ${bp.name}\n`));
				const neoBreakpoint = <DebugProtocol.FunctionBreakpoint>{name: bp.name};
				neoBreakpoints.push(neoBreakpoint);
				response.body.breakpoints = [new Breakpoint(true, 4, 0, new Source('Module.pm', join(/* this.filepath, */ 'Module.pm')) )];
				this.sendResponse(response);

				this.sendEvent(new OutputEvent(`Add ${bp.name}\n`));
			} else {
				neoBreakpoints.push(bp);
			}
		}

		this._functionBreakPoints = breakpoints;

		return response;
	}

	protected setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments): void {
		this.setFunctionBreakPointsRequestAsync(response, args)
			.then(res => {
				this.sendResponse(response);
			})
			.catch(err => {
				const [ error = err ] = err.errors || [];
				this.sendEvent(new OutputEvent(`ERR>setFunctionBreakPointsRequest error: ${error.message}\n`));
				response.success = false;
				this.sendResponse(response);
			});
	}

/**
 * Implemented
 */

	/**
	 * Set variable
	 */
    protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
		// Get type of variable contents
		const name = this.getVariableName(args.name, args.variablesReference)
			.then((variableName) => {

				return this.perlDebugger.request(`${variableName}='${args.value}'`)
					.then(() => {
						response.body = {
							value: args.value,
							type: variableType(args.value),
						};
						this.sendResponse(response);
					});
			})
			.catch((err) => {
				const [ error = err ] = err.errors || [];
				this.sendEvent(new OutputEvent(`ERR>setVariableRequest error: ${error.message}\n`));
				response.success = false;
				this.sendResponse(response);
			});
	}

	/**
	 * Step out
	 */
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.perlDebugger.request('r')
			.then((res) => {
				if (res.ln) {
					this._currentLine = this.convertDebuggerLineToClient(res.ln);
				}

				this.sendResponse(response);

				if (res.finished) {
					this.sendEvent(new TerminatedEvent());
				} else {
					this.sendEvent(new StoppedEvent("step", PerlDebugSession.THREAD_ID));
				}
				// no more lines: run to end
			})
			.catch(err => {
				const [ error = err ] = err.errors || [];
				if (err.exception) {
					this.sendEvent(new StoppedEvent("exception", PerlDebugSession.THREAD_ID, error.near));
				} else {
					this.sendEvent(new OutputEvent(`ERR>StepOut error: ${error.message}\n`));
					this.sendEvent(new TerminatedEvent());
				}
				response.success = false;
				this.sendResponse(response);
			});
	}

	/**
	 * Step in
	 */
    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this.perlDebugger.request('s')
			.then((res) => {
				if (res.ln) {
					this._currentLine = this.convertDebuggerLineToClient(res.ln);
				}

				this.sendResponse(response);

				if (res.finished) {
					this.sendEvent(new TerminatedEvent());
				} else {
					this.sendEvent(new StoppedEvent("step", PerlDebugSession.THREAD_ID));
				}
				// no more lines: run to end
			})
			.catch(err => {
				const [ error = err ] = err.errors || [];
				if (err.exception) {
					this.sendEvent(new StoppedEvent("exception", PerlDebugSession.THREAD_ID, error.near));
				} else {
					this.sendEvent(new OutputEvent(`ERR>StepIn error: ${error.message}\n`));
					this.sendEvent(new TerminatedEvent());
				}
				response.success = false;
				this.sendResponse(response);
			});
	}

	/**
	 * Restart
	 */
	private async restartRequestAsync(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments): Promise<DebugProtocol.RestartResponse> {
		const res = await this.perlDebugger.request('R')
		if (res.ln) {
			this._currentLine = this.convertDebuggerLineToClient(res.ln);
		}
		if (res.finished) {
			this.sendEvent(new TerminatedEvent());
		} else {
			this.sendEvent(new StoppedEvent("entry", PerlDebugSession.THREAD_ID));
		}

		return response;
	}

	protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments): void {
		this.restartRequestAsync(response, args)
			.then(res => this.sendResponse(res))
			.catch(err => {
				response.success = false;
				this.sendResponse(response);
			});
	}

	/**
	 * Breakpoints
	 */
	private async setBreakPointsRequestAsync(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<DebugProtocol.SetBreakpointsResponse> {

		const path = args.source.path;

		const debugPath = await this.perlDebugger.relativePath(path);
		const editorExisting = this._breakPoints.get(path);
		const editorBPs: number[] = args.lines.map(ln => ln);
		const dbp = await this.perlDebugger.getBreakPoints();
		const debuggerPBs: number[] = (await this.perlDebugger.getBreakPoints())[debugPath] || [];
		const createBP: number[] = [];
		const removeBP: number[] = [];
		const breakpoints = new Array<Breakpoint>();

		// Clean up debugger removing unset bps
		for (let i = 0; i < debuggerPBs.length; i++) {
		 	const ln = debuggerPBs[i];
			if (editorBPs.indexOf(ln) < 0) {
				await this.perlDebugger.clearBreakPoint(ln, debugPath);
			}
		}

		// Add missing bps to the debugger
		for (let i = 0; i < editorBPs.length; i++) {
		 	const ln = editorBPs[i];
			if (debuggerPBs.indexOf(ln) < 0) {
				try {
					const res = await this.perlDebugger.setBreakPoint(ln, debugPath);
					const bp = <DebugProtocol.Breakpoint> new Breakpoint(true, ln);
					bp.id = this._breakpointId++;
					breakpoints.push(bp);
				} catch(err) {
					const bp = <DebugProtocol.Breakpoint> new Breakpoint(false, ln);
					bp.id = this._breakpointId++;
					breakpoints.push(bp);
				}
			} else {
				// This is good
				const bp = <DebugProtocol.Breakpoint> new Breakpoint(true, ln);
				bp.id = this._breakpointId++;
				breakpoints.push(bp);
			}
		}

		this._breakPoints.set(path, breakpoints);

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: breakpoints
		};

		return response;
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		this.setBreakPointsRequestAsync(response, args)
			.then(res => this.sendResponse(res))
			.catch(err => {
				response.success = false;
				this.sendResponse(response)
			});
	}

	/**
	 * Next
	 */
	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.perlDebugger.request('n')
			.then((res) => {
				if (res.ln) {
					this._currentLine = this.convertDebuggerLineToClient(res.ln);
				}

				this.sendResponse(response);

				if (res.finished) {
					this.sendEvent(new TerminatedEvent());
				} else {
					this.sendEvent(new StoppedEvent("step", PerlDebugSession.THREAD_ID));
				}
				// no more lines: run to end
			})
			.catch(err => {
				const [ error = err ] = err.errors || [];
				if (err.exception) {
					this.sendEvent(new StoppedEvent("exception", PerlDebugSession.THREAD_ID, error.near));
				} else {
					this.sendEvent(new OutputEvent(`ERR>Next error: ${error.message}\n`));
					this.sendEvent(new TerminatedEvent());
				}
				response.success = false;
				this.sendResponse(response);
			});
	}


	/**
	 * Continue
	 */
	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {

		// NOTE(bh): "Please note: a debug adapter is not expected to
		// send this event in response to a request that implies that
		// execution continues, e.g. ‘launch’ or ‘continue’." -- but in
		// our case sending the `c` command to the debugger is never
		// acknowledged by the debugger, we cannot tell if it succeeded
		// and the promise below is resolved only once the debugger has
		// halted execution of the debuggee again. Without a response to
		// the `continueRequest`, vscode does not offer users a `pause`
		// button, so without sending this event, we cannot pause from
		// the debug user interface. So we send the event...

		this.sendEvent(new ContinuedEvent(PerlDebugSession.THREAD_ID));

		this.perlDebugger.request('c')
			.then((res) => {
				if (res.ln) {
					this._currentLine = this.convertDebuggerLineToClient(res.ln);
				}
				this.sendResponse(response);

				if (res.finished) {
					this.sendEvent(new TerminatedEvent());
				} else {
					this.sendEvent(new StoppedEvent("breakpoint", PerlDebugSession.THREAD_ID));
				}
			})
			.catch((err) => {
				const [ error = err ] = err.errors || [];
				if (err.exception) {
					this.sendEvent(new StoppedEvent("exception", PerlDebugSession.THREAD_ID, error.near));
				} else {
					this.sendEvent(new OutputEvent(`ERR>Continue error: ${error.message}\n`));
					this.sendEvent(new TerminatedEvent());
				}

				response.success = false;
				this.sendResponse(response);
			});
	}

	/**
	 * Scope request
	 */
	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		const frameReference = args.frameId;
		const scopes = new Array<Scope>();
		scopes.push(new Scope("Local", this._variableHandles.create("local_" + frameReference), false));
		scopes.push(new Scope("Closure", this._variableHandles.create("closure_" + frameReference), false));
		scopes.push(new Scope("Global", this._variableHandles.create("global_" + frameReference), true));

		response.body = {
			scopes: scopes
		};
		this.sendResponse(response);
	}

	private getVariableName(name: string, variablesReference: number): Promise<string> {
		let id = this._variableHandles.get(variablesReference);
		return this.perlDebugger.variableList({
			global_0: 0,
			local_0: 1,
			closure_0: 2,
		})
		.then(variables => {
			return resolveVariable(name, id, variables);
		});
	}

	/**
	 * Variable scope
	 */
	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
		const id = this._variableHandles.get(args.variablesReference);

		this.perlDebugger.variableList({
			global_0: 0,
			local_0: 1,
			closure_0: 2,
		})
			.then(variables => {
				const result = [];

				if (id != null && variables[id]) {
					const len = variables[id].length;
					const result = variables[id].map(variable => {
						// Convert the parsed variablesReference into Variable complient references
						if (variable.variablesReference === '0') {
							variable.variablesReference = 0;
						} else {
							variable.variablesReference = this._variableHandles.create(`${variable.variablesReference}`);
						}
						return variable;
					});

					response.body = {
						variables: <Variable[]>result
					};
					this.sendResponse(response);
				} else {
					this.sendResponse(response);
				}
			})
			.catch(() => {
				response.success = false;
				this.sendResponse(response);
			});
	}

	/**
	 * Evaluate hover
	 */
	private evaluateHover(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {
		if (/^[\$|\@]/.test(args.expression)) {
			const expression = args.expression.replace(/\.(\'\w+\'|\w+)/g, (...a) => `->{${a[1]}}`);

			this.perlDebugger.getExpressionValue(expression)
				.then(result => {
					if (/^HASH/.test(result)) {
						response.body = {
							result: result,
							variablesReference: this._variableHandles.create(result),
							type: 'string'
						};
					} else {
						response.body = {
							result: result,
							variablesReference: 0
						};
					}
					this.sendResponse(response);
				})
				.catch(() => {
					response.body = {
						result: undefined,
						variablesReference: 0
					};
					this.sendResponse(response);
				});
		} else {
			this.sendResponse(response);
		}
	}


	/**
	 * Evaluate command line
	 */
	private evaluateCommandLine(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {
		this.perlDebugger.request(args.expression)
			.then((res) => {
				if (res.data.length > 1) {
					res.data.forEach((line) => {
						this.sendEvent(new OutputEvent(`> ${line}\n`));
					});
					response.body = {
						result: `Result:`,
						variablesReference: 0,
					};
				} else {
					response.body = {
						result: `${res.data[0]}`,
						variablesReference: 0
					};
				}
				this.sendResponse(response);
			});
	};

	/**
	 * Fetch expression value
	 */
	async fetchExpressionRequest(clientExpression): Promise<any> {

		const isVariable = /^([\$|@|%])([a-zA-Z0-9_\'\.]+)$/.test(clientExpression);

		const expression = isVariable ? clientExpression.replace(/\.(\'\w+\'|\w+)/g, (...a) => `->{${a[1]}}`) : clientExpression;

		let value = await this.perlDebugger.getExpressionValue(expression);
		if (/^Can\'t use an undefined value as a HASH reference/.test(value)) {
			value = undefined;
		}

		const reference = isVariable ? await this.perlDebugger.getVariableReference(expression) : null;
		if (typeof value !== 'undefined' && /^HASH|ARRAY/.test(reference)) {
			return {
				value: reference,
				reference: reference,
			};
		}
		return {
			value: value,
			reference: null,
		};
	}

	/**
	 * Evaluate watch
	 * Note: We don't actually levarage the debugger watch capabilities yet
	 */
	protected evaluateWatch(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
		// Clear watch if last request wasn't setting a watch?
		this.fetchExpressionRequest(args.expression)
			.then(result => {
				// this.sendEvent(new OutputEvent(`${args.expression}=${result.value} ${typeof result.value} ${result.reference}$')\n`));
				if (typeof result.value !== 'undefined') {
					response.body = {
						result: result.value,
						variablesReference: result.reference === null ? 0 : this._variableHandles.create(result.reference),
					};
				}
				this.sendResponse(response);
			})
			.catch(() => {});
	}

	/**
	 * Evaluate
	 */
	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

		if (args.context === 'repl') {
			this.evaluateCommandLine(response, args);
		} else if (args.context === 'hover') {
			this.evaluateHover(response, args);
		} else if (args.context === 'watch') {
			this.evaluateWatch(response, args);
		} else {
			this.sendEvent(new OutputEvent(`evaluate(context: '${args.context}', '${args.expression}')`));
			response.body = {
				result: `evaluate(context: '${args.context}', '${args.expression}')`,
				variablesReference: 0
			};
			this.sendResponse(response);
		}
	}

	/**
	 * Stacktrace
	 */
	private async stackTraceRequestAsync(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<DebugProtocol.StackTraceResponse> {

		// FIXME(bh): There is probably a better way to re-use the code
		// in that function that does not require setting up a malformed
		// object here, but this seems good enough for the moment.
		await this.loadedSourcesRequestAsync(
			{} as DebugProtocol.LoadedSourcesResponse,
			{}
		);

		const stacktrace = await this.perlDebugger.getStackTrace();
		const frames = new Array<StackFrame>();

		// In case this is a trace run on end, we want to return the file with the exception in the @ position
		let endFrame = null;

		stacktrace.forEach((trace, i) => {
			const frame = new StackFrame(i, `${trace.caller}`, new Source(basename(trace.filename),
				this.convertDebuggerPathToClient(trace.filename)),
				trace.ln, 0);
			frames.push(frame);
			if (trace.caller === 'DB::END()') {
				endFrame = frame;
			}
		});

		if (endFrame) {
			frames.unshift(endFrame);
		}

		response.body = {
			stackFrames: frames,
			totalFrames: frames.length
		};

		return response;
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		this.stackTraceRequestAsync(response, args)
			.then(res => this.sendResponse(res))
			.catch(err => {
				const [ error = err ] = err.errors || [];
				this.sendEvent(new OutputEvent(`--->Trace error...${error.message}\n`));
				response.success = false;
				response.body = {
					stackFrames: [],
					totalFrames: 0
				};
				this.sendResponse(response);
			});
	}

	private async loadedSourcesRequestAsync(response: DebugProtocol.LoadedSourcesResponse, args: DebugProtocol.LoadedSourcesArguments): Promise<DebugProtocol.LoadedSourcesResponse> {

		const loadedFiles = await this.perlDebugger.getLoadedFiles();

		const newFiles = loadedFiles.filter(
			x => !this._loadedSources.has(x)
		);

		for (const file of newFiles) {

			const newSource = new Source(
				file,
				file,
				// no sourceReference when debugging locally, so vscode will
				// open the local file rather than retrieving a read-only
				// version of the code through the debugger (that lacks code
				// past `__END__` markers, among possibly other limitations).
				this.perlDebugger.isRemote
					? this._loadedSources.size
					: 0
			);

			this.sendEvent(new LoadedSourceEvent("new", newSource));

			this._loadedSources.set(file, newSource);

		}

		response.body = {
			sources: [...this._loadedSources.values()]
		};

		return response;

	}

	protected loadedSourcesRequest(response: DebugProtocol.LoadedSourcesResponse, args: DebugProtocol.LoadedSourcesArguments) {

		this.loadedSourcesRequestAsync(response, args)
			.then(res => this.sendResponse(res))
			.catch(err => {

				const [ error = err ] = err.errors || [];
				this.sendEvent(new OutputEvent(`--->Loaded sources request error...${error.message}\n`));
				response.success = false;
				response.body = {
					sources: [
					]
				};
				this.sendResponse(response);
			});

	}

	private async sourceRequestAsync(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments): Promise<DebugProtocol.SourceResponse> {

		// NOTE(bh): When sources reported by `loadedSources` have some
		// non-zero `sourceReference` specified, Visual Studio Code will
		// ask us for the source code, otherwise it interprets the `path`
		// as a local file. Our `loadedSources` takes the paths from the
		// Perl debugger, and `sourceReference` is just a counter value.
		// Accordingly there is no point for us to distinguish the cases.

		if (args.source && args.source.sourceReference) {
			// retrieve by source reference
		} else {
			// retrieve by path
		}

		response.body = {
			content: await this.perlDebugger.getSourceCode(
				args.source.path
			)
		};

		return response;
	}

	protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments) {

		this.sourceRequestAsync(response, args)
			.then(res => this.sendResponse(res))
			.catch(err => {

				const [ error = err ] = err.errors || [];
				this.sendEvent(new OutputEvent(`--->Source request error...${error.message}\n`));
				response.success = false;
				response.body = {
					content: `# error`,
					mimeType: `text/vnd.vscode-perl-debug.error`,
				};
				this.sendResponse(response);

			});

	}

	// Custom requests

	protected customRequest(command: string, response: DebugProtocol.Response, args: any) {
		if (command === '...') {
			// this....(response, args);
		}
	}

}

