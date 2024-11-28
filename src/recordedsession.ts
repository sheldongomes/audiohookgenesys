import { FastifyLoggerInstance, LogLevel } from 'fastify';
import { IncomingHttpHeaders } from 'http';
import { WriteStream, createWriteStream, createReadStream } from 'fs';
import { unlink, stat } from 'fs/promises';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
    ClientMessage, 
    createServerSession,
    Duration,
    JsonObject, 
    Logger,
    MediaDataFrame, 
    normalizeError,
    ServerMessage, 
    ServerWebSocket,
    ServerSession,
    StatisticsInfo,
    StreamDuration, 
    Uuid,
    WavFileWriter,
} from '../audiohook';
import { v4 as uuid } from 'uuid';
import path from 'path';
import { destination } from 'pino';
const { Storage } = require('@google-cloud/storage')

const storage = new Storage({
    keyFilename: process.env['TEST_SHELDON'],
  })
const bucketName = 'test-audio-hook'
const googleBucket = storage.bucket(bucketName)

export type RecordingBucket = {
    readonly service: S3Client;
    readonly name: string;
};

type MoveFileToBucketResult = {
    uri: string;
    size: number;
};

const moveFileToBucket = async (srcpath: string, bucket: RecordingBucket, key: string): Promise<MoveFileToBucketResult> => {

    const { size } = await stat(srcpath);

    const request = new PutObjectCommand({
        Bucket: bucket.name,
        Key: key,
        Body: createReadStream(srcpath)
    });
    await bucket.service.send(request);

    console.log(`Sheldon bucket File path: ${srcpath}`)
    console.log(`Sheldon bucket Destination: ${key}`)
    googleBucket.upload(`${srcpath}`, {destination: `${key}`}, function (err: any, file: any) {
        if(err) {
            console.log(`Error: ${err}`)
        } else {
            console.log(`Uploaded to ${bucketName}.`)
        }
    })

    // Successfully copied to S3, delete the source file.
    await unlink(srcpath);

    //return { uri: `s3://${bucket.name}/${key}`, size };
    return { uri: 's3://arn:aws:s3:sa-east-1:024153147757:accesspoint/heroku/metadata/', size}
};


const logLevelMap: {
    [key in LogLevel]: number;
} = {
    'fatal': 60,
    'error': 50,
    'warn':  40,
    'info':  30,
    'debug': 20,
    'trace': 10,
    'silent': 0,
} as const;

const logLevelNames = Object.entries(logLevelMap).sort(([,a], [, b]) => (a - b)).map(([k]) => k as LogLevel);

const lookupLogLevelName = (level: number): LogLevel => (
    logLevelNames[Math.floor((level - 5) / 10)]
);


class SidecarFileWriter {
    readonly id = uuid();
    readonly startTime = new Date();
    readonly startTimestamp = process.hrtime.bigint();
    readonly filepath: string;
    readonly logger: Logger;
    readonly outerLogger: FastifyLoggerInstance;

    fileWriter: WriteStream | null;
    rowcnt = 0;

    minLogLevelSidecar = 20;
    minLogLevelOuter: number;

    constructor(pathBase: string, outerLogger: FastifyLoggerInstance, outerLogLevel: LogLevel) {
        this.outerLogger = outerLogger;
        this.minLogLevelOuter = logLevelMap[outerLogLevel];
        this.filepath = path.join(pathBase, `${this.id}.json`);
        this.fileWriter = createWriteStream(this.filepath, { encoding: 'utf-8' });
        const header = {
            timestamp: this.startTime.toISOString(),
            id: this.id
        };
        this.fileWriter.write(`{\n "header":${JSON.stringify(header)},\n "body":[`);

        this.logger = {
            fatal: (msg: string): void => this.writeLogEntry(60, msg),
            error: (msg: string): void => this.writeLogEntry(50, msg),
            warn: (msg: string): void => this.writeLogEntry(40, msg),
            info: (msg: string): void => this.writeLogEntry(30, msg),
            debug: (msg: string): void => this.writeLogEntry(20, msg),
            trace: (msg: string): void => this.writeLogEntry(10, msg),
        };
    }

    async close(): Promise<void> {
        if(this.fileWriter) {
            this.renderEntry('end', {});
            const fileWriter = this.fileWriter;
            this.fileWriter = null;
            fileWriter.end('\n ]\n}\n');
            return new Promise((resolve, reject) => {
                fileWriter.on('finish', resolve);
                fileWriter.on('error', reject);
            });
        } else {
            throw new Error('Writer already closed');
        }
    }

    getTimestamp(): Duration {
        return StreamDuration.fromNanoseconds(process.hrtime.bigint() - this.startTimestamp).asDuration();
    }

    writeLogEntry(level: number, msg: string): void {
        if (level >= this.minLogLevelOuter) {
            this.outerLogger[lookupLogLevelName(level)](msg);
        }
        if(level >= this.minLogLevelSidecar) {
            this.renderEntry('logger', { level, msg });
        }
    }

    writeReceivedMessage(message: JsonObject): void {
        this.renderEntry('audiohook', { dir: 'in', message });
    }

    writeSentMessage(message: JsonObject): void {
        this.renderEntry('audiohook', { dir: 'out', message });
    }

    writeStatisticsUpdate(info: StatisticsInfo): void {
        this.renderEntry('statistics', { 
            rtt: info.rtt.asDuration()
        });
    }

    writeHttpRequestInfo(headers: IncomingHttpHeaders, uri: string) {
        this.renderEntry('httpInfo', { uri, headers: headers as JsonObject });
    }

    renderEntry(type: string, data: JsonObject): boolean {
        const timestamp = this.getTimestamp();
        return this.fileWriter?.write(`${this.rowcnt++ === 0 ? '' : ','}\n  ${JSON.stringify({ timestamp, type, data })}`) ?? true;
    }
}

const activeSessions = new Map<string, RecordedSession>();


export type RecordedSessionConfig = {
    readonly ws: ServerWebSocket;
    readonly sessionId: Uuid;
    readonly requestHeader: IncomingHttpHeaders;
    readonly requestUri: string;
    readonly outerLogger: FastifyLoggerInstance;
    readonly outerLogLevel: LogLevel;
    readonly filePathRoot: string;
    readonly recordingBucket: RecordingBucket | null;
};

export class RecordedSession {
    readonly recordingId: string;
    readonly session: ServerSession;
    readonly sidecar: SidecarFileWriter;
    readonly recordingBucket: RecordingBucket | null;
    filePathWav: string | null = null;

    private unregister: (() => void) | null;

    private constructor(session: ServerSession, sidecar: SidecarFileWriter, config: RecordedSessionConfig) {
        this.recordingId = sidecar.id;
        this.session = session;
        this.sidecar = sidecar;
        this.recordingBucket = config.recordingBucket;

        this.session.addFiniHandler(async () => this.onSessionFini());
        activeSessions.set(this.recordingId, this);

        this.addAudioWriter();

        this.unregister = (() => {
            const handleStatistics = (info: StatisticsInfo) => this.onStatisticsUpdate(info);
            const handleClientMessage = (message: ClientMessage) => this.onClientMessage(message);
            const handleServerMessage = (message: ServerMessage) => this.onServerMessage(message);
            this.session.on('statistics', handleStatistics);
            this.session.on('clientMessage', handleClientMessage);
            this.session.on('serverMessage', handleServerMessage);
            return () => {
                this.session.off('statistics', handleStatistics);
                this.session.off('clientMessage', handleClientMessage);
                this.session.off('serverMessage', handleServerMessage);
            };
        })();
    }

    static create(config: RecordedSessionConfig): RecordedSession {
        const sidecar = new SidecarFileWriter(config.filePathRoot, config.outerLogger, config.outerLogLevel);
        sidecar.writeHttpRequestInfo(config.requestHeader, config.requestUri);
        const session = createServerSession({
            ws: config.ws,
            id: config.sessionId,
            logger: sidecar.logger
        });
        return new RecordedSession(session, sidecar, config);
    }

    addAudioWriter(): void {
        this.session.addOpenHandler(
            async ({ session, selectedMedia }) => {
                if (!selectedMedia) {
                    return; // If we don't have media we don't create a WAV file
                }
                this.filePathWav = `${this.sidecar.filepath.slice(0, -4)}wav`;
                session.logger.info(`Creating WAV file: "${this.filePathWav}"`);
                const writer = await WavFileWriter.create(this.filePathWav, selectedMedia.format, selectedMedia.rate, selectedMedia.channels.length);
                const listener = (frame: MediaDataFrame): void => {
                    writer.writeAudio(frame.audio.data);
                };
                session.on('audio', listener);
                return async () => {
                    // Close handler
                    session.off('audio', listener);
                    const samples = await writer.close();
                    session.logger.info(`Closed WAV file "${this.filePathWav}", SamplesWritten: ${samples} (${samples/selectedMedia.rate}s)`);
                };
            }
        );
    }

    onClientMessage(message: ClientMessage): void {
        this.sidecar.writeReceivedMessage(message);
    }

    onServerMessage(message: ServerMessage): void {
        this.sidecar.writeSentMessage(message);
    }

    onStatisticsUpdate(info: StatisticsInfo): void {
        this.sidecar.writeStatisticsUpdate(info);
    }

    async onSessionFini(): Promise<void> {
        this.unregister?.();
        this.unregister = null;
        const outerLogger = this.sidecar.outerLogger;
        await this.sidecar.close();

        outerLogger.info(`Finalized and closed sidecar file: ${this.sidecar.filepath}`);

        let s3UriWav: string | null = null;
        let s3UriSidecar: string | null = null;
        if(this.recordingBucket) {
            const iso8601 = this.sidecar.startTime.toISOString();
            const keybase = `${iso8601.substring(0, 10)}/${this.sidecar.id}`;

            if(this.filePathWav) {
                try {
                    const { uri, size } = await moveFileToBucket(this.filePathWav, this.recordingBucket, `${keybase}.wav`);
                    s3UriWav = uri;
                    outerLogger.info(`Moved ${this.filePathWav} to ${s3UriWav}. Size: ${size}`);
                } catch(err) {
                    outerLogger.warn(`Error copying "${this.filePathWav}" to bucket=${this.recordingBucket.name}, key=${keybase}.wav: ${normalizeError(err).message}`);
                }
            }

            try {
                const { uri, size } = await moveFileToBucket(this.sidecar.filepath, this.recordingBucket, `${keybase}.json`);
                s3UriSidecar = uri;
                outerLogger.info(`Moved ${this.sidecar.filepath} to ${s3UriSidecar}. Size: ${size}`);
            } catch(err) {
                outerLogger.warn(`Error copying "${this.sidecar.filepath}" to bucket=${this.recordingBucket.name}, key=${keybase}.json: ${normalizeError(err).message}`);
            }

        } else {
            outerLogger.warn(`No S3 bucket configured, files not uploaded. Sidecar: ${this.sidecar.filepath}, WAV: ${this.filePathWav ? this.filePathWav : '<none>'}`);
        }
        
        // All data moved to S3. Session complete for good.
        // TODO: Update/add record in/to DynamoDB
        
        activeSessions.delete(this.recordingId);
    }
}
