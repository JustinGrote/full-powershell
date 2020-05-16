import os from 'os';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { Observable, Subject, ReplaySubject, zip } from 'rxjs';
import { map, publish, switchMap, take } from 'rxjs/operators';
import { Readable, Writable } from 'stream';
import { wrap, Format } from './wrapper';

interface RawStreams {
    success: string;
    error: string;
    warning: string;
    info: string;
    format: Format;
}

export interface PowerShellStreams {
    success: Array<any>;
    error: Array<any>;
    warning: Array<any>;
    info: Array<any>;
}

function parseStream(stream: string, format: Format) {
    if (format != null) {
        return JSON.parse(stream);
    } else {
        return stream;
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
            sub.next();
        } else {
            stream.once('drain', () => sub.next());
        }
    });
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
    private delimit_head = 'F0ZU7Wm1p4';
    private delimit_tail = 'AdBmCXEdsB';

    private command$ = new Subject<[string, Subject<PowerShellStreams>]>();
    private ready$ = new ReplaySubject(1);
    private streams$ = new Subject<PowerShellStreams>();

    constructor() {
        this.initPowerShell();
        this.initReaders();
        this.initQueue();
        this.ready$.next();
    }

    private initPowerShell(){
        const args = ['-NoLogo', '-NoExit', '-Command', '-'];
        const exe = os.platform() === 'win32' ? 'powershell' : 'pwsh';

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

    private initReaders(){
        let read_out = new BufferReader(this.delimit_head, this.delimit_tail);
        let read_err = new BufferReader(this.delimit_head, this.delimit_tail);

        this.stdout.pipe(read_out);
        this.stderr.pipe(read_err);

        read_out.subject.subscribe((res: string) => {
            try {
                let result = JSON.parse(res).result as RawStreams;
                let success = parseStream(result.success, result.format);
                let error = parseStream(result.error, 'json');
                let warning = parseStream(result.warning, 'json');
                let info = parseStream(result.info, 'json');

                let streams: PowerShellStreams = {
                    success, error, warning, info
                };

                this.streams$.next(streams);

                if (success.length > 0) this.success$.next(success);
                if (error.length > 0) this.error$.next(error);
                if (warning.length > 0) this.warning$.next(warning);
                if (info.length > 0) this.info$.next(info);

            } catch (e) {
                console.log(res);
                console.log(e);
            } finally {
                this.ready$.next();
            }
        });

        read_err.subject.subscribe((res) => {
            this.error$.next([res]);
        });
    }

    private initQueue(){
        zip(this.command$, this.ready$).pipe(
            map((values) => values[0]),
            publish((hot$) => hot$)
        ).subscribe(([command, callback$]) => {
            write(this.stdin, command).pipe(
                switchMap(() => this.streams$.pipe(take(1)))
            ).subscribe(res => {
                callback$.next(res);
                callback$.complete();
            })
        })
    }

    public call(string: string, format: Format = 'json'): Subject<PowerShellStreams> {
        const command = wrap(string, this.delimit_head, this.delimit_tail, format);
        const call$ = new Subject<PowerShellStreams>();
        this.command$.next([command, call$]);
        return call$;
    }

    public destroy() {
        return this.powershell.kill();
    }
}
