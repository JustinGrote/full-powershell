import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import os from 'os';
import { BehaviorSubject, combineLatest, firstValueFrom, Observable, Subject } from 'rxjs';
import { finalize, map, take } from 'rxjs/operators';
import { Readable, Writable } from 'stream';
import { Format, wrap } from './wrapper';
import { debug } from 'debug';

const log = {
    info: debug('fps:info'),
    error: debug('fps:error')
}

interface QueuedCommand {
    command: string;
    wrapped: string;
    subject: Subject<PowerShellStreams>;
}

interface RawStreams {
    success: string;
    error: string;
    warning: string;
    verbose: string;
    debug: string;
    info: string;
    format: Format;
}

export interface PowerShellStreams {
    success: Array<any>;
    error: Array<any>;
    warning: Array<any>;
    verbose: Array<any>;
    debug: Array<any>;
    info: Array<any>;
}

function parseStream(stream: string, format: Format) {
    if (format != null) {
        return JSON.parse(stream);
    } else {
        return stream;
    }
}

class SubjectWithPromise<T> extends Subject<T> {
    async promise() {
        return firstValueFrom(this);
    }
}

class BufferReader extends Writable {
    public subject = new Subject<string>();
    private buffer: Buffer = Buffer.from('');
    private head: Buffer;
    private tail: Buffer;

    constructor(head: string, tail: string) {
        super();
        this.head = Buffer.from(head);
        this.tail = Buffer.from(tail);
    }

    extract(): Buffer {
        let head_idx = this.buffer.indexOf(this.head);
        let tail_idx = this.buffer.indexOf(this.tail);
        let data = this.buffer.slice(head_idx + this.head.length, tail_idx);
        this.buffer = this.buffer.slice(tail_idx + this.tail.length);
        return data;
    }

    _write(chunk: Buffer, encoding: string, callback: Function) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.includes(this.tail)) {
            const extracted = this.extract();
            this.subject.next(extracted.toString('utf8'));
        }
        callback();
    }
}

function write(stream: Writable, string: string) {
    return new Observable((sub) => {
        let success = stream.write(Buffer.from(string));
        if (success) {
            sub.complete();
        } else {
            stream.once('drain', () => sub.complete());
        }
    });
}

interface PowerShellOptions {
    tmp_dir?: string
    exePath?: string
}

export class PowerShell {
    public success$ = new Subject<Array<any>>();
    public error$ = new Subject<Array<any>>();
    public warning$ = new Subject<Array<any>>();
    public verbose$ = new Subject<Array<any>>();
    public debug$ = new Subject<Array<any>>();
    public info$ = new Subject<Array<any>>();

    private powershell: ChildProcessWithoutNullStreams;
    private stdin: Writable;
    private stdout: Readable;
    private stderr: Readable;

    private read_out: BufferReader;
    private read_err: BufferReader;

    private delimit_head = 'F0ZU7Wm1p4';
    private delimit_tail = 'AdBmCXEdsB';

    private queue: Array<QueuedCommand> = [];

    private ready$ = new BehaviorSubject<boolean>(false);
    private queued$ = new Subject<QueuedCommand>();

    private tmp_dir = '';
    private exePath = '';

    constructor(private options?: PowerShellOptions) {
        if (!!options) this.setOptions(options);
        this.initPowerShell();
        this.initReaders();
        this.initQueue();
        this.ready$.next(true);
    }

    setOptions(options: PowerShellOptions) {
        if (options.tmp_dir) this.tmp_dir = options.tmp_dir;
    }

    private initPowerShell() {
        const args = ['-NoLogo', '-NoExit', '-Command', '-'];
        const exe = this.exePath ?? os.platform() === 'win32' ? 'powershell' : 'pwsh';

        this.powershell = spawn(exe, args, { stdio: 'pipe' });

        if (!this.powershell.pid) {
            throw new Error('could not start child process');
        }

        this.powershell.once('error', () => {
            throw new Error('child process threw an error');
        });

        this.powershell.stdin.setDefaultEncoding('utf8');
        this.powershell.stdout.setEncoding('utf8');
        this.powershell.stderr.setEncoding('utf8');

        this.stdin = this.powershell.stdin;
        this.stdout = this.powershell.stdout;
        this.stderr = this.powershell.stderr;
    }

    private initReaders() {
        this.read_out = new BufferReader(this.delimit_head, this.delimit_tail);
        this.read_err = new BufferReader(this.delimit_head, this.delimit_tail);
        this.stdout.pipe(this.read_out);
        this.stderr.pipe(this.read_err);
        this.read_err.subject.subscribe((res) => {
            this.error$.next([res]);
        });
    }

    private initQueue() {
        combineLatest([this.queued$, this.ready$])
            .subscribe(([_, ready]) => {
                if (ready && this.queue.length > 0) {
                    let next = this.queue.shift() as QueuedCommand;
                    log.info('Running: %O', next.command)
                    this._call(next.wrapped).subscribe(
                        (res) => {
                            next.subject.next(res);
                            next.subject.complete();
                        },
                        (err) => {
                            next.subject.error(err);
                        }
                    );
                }
            });
    }

    private _call(wrapped: string): Observable<PowerShellStreams> {
        this.ready$.next(false);

        write(this.stdin, wrapped).subscribe();

        return this.read_out.subject.pipe(
            take(1),
            map((res: string) => {
                let result = JSON.parse(res).result as RawStreams;
                let success = parseStream(result.success, result.format);
                let error = parseStream(result.error, 'json');
                let warning = parseStream(result.warning, 'json');
                let verbose = parseStream(result.verbose, 'string');
                let debug = parseStream(result.debug, 'string');
                let info = parseStream(result.info, 'json');

                if (success.length > 0) this.success$.next(success);
                if (error.length > 0) this.error$.next(error);
                if (warning.length > 0) this.warning$.next(warning);
                if (verbose.length > 0) this.verbose$.next(verbose);
                if (debug.length > 0) this.debug$.next(debug);
                if (info.length > 0) this.info$.next(info);

                let streams: PowerShellStreams = {
                    success,
                    error,
                    warning,
                    verbose,
                    debug,
                    info,
                };

                return streams;
            }),
            finalize(() => this.ready$.next(true))
        );
    }

    public call(command: string, format: Format = 'json') {
        const subject = new SubjectWithPromise<PowerShellStreams>();
        const wrapped = wrap(
            command,
            this.delimit_head,
            this.delimit_tail,
            format,
            this.tmp_dir
        );
        const queued: QueuedCommand = {
            command: command,
            wrapped: wrapped,
            subject: subject,
        }
        this.queue.push(queued);
        this.queued$.next(queued);
        return subject;
    }

    public destroy() {
        return this.powershell.kill();
    }
}