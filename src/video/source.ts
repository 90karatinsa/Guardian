import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const ffmpegPath = ffmpegStatic as string | null;
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type VideoSourceOptions = {
  file: string;
  framesPerSecond: number;
};

export class VideoSource extends EventEmitter {
  private command: ffmpeg.FfmpegCommand | null = null;

  constructor(private readonly options: VideoSourceOptions) {
    super();
  }

  start() {
    this.command = ffmpeg(this.options.file)
      .outputOptions('-vf', `fps=${this.options.framesPerSecond}`)
      .outputOptions('-f', 'image2pipe')
      .outputOptions('-vcodec', 'png')
      .on('error', err => {
        this.emit('error', err);
      })
      .on('end', () => {
        this.emit('end');
      });

    const stream = this.command.pipe();
    this.consume(stream);
  }

  stop() {
    if (this.command) {
      this.command.kill('SIGINT');
      this.command = null;
    }
  }

  consume(stream: Readable) {
    let buffer = Buffer.alloc(0);

    stream.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      buffer = this.extractFrames(buffer);
    });

    stream.on('error', err => {
      this.emit('error', err);
    });
  }

  private extractFrames(buffer: Buffer) {
    let working = buffer;

    while (true) {
      const pngStart = working.indexOf(PNG_SIGNATURE);

      if (pngStart === -1) {
        return working;
      }

      if (pngStart > 0) {
        working = working.subarray(pngStart);
      }

      const frame = slicePng(working);
      if (!frame) {
        return working;
      }

      this.emit('frame', frame.png);
      working = frame.remainder;
    }
  }
}

type SliceResult = {
  png: Buffer;
  remainder: Buffer;
};

function slicePng(buffer: Buffer): SliceResult | null {
  if (buffer.length < PNG_SIGNATURE.length) {
    return null;
  }

  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }

  let offset = PNG_SIGNATURE.length;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const chunkType = buffer.toString('ascii', offset + 4, offset + 8);
    const chunkEnd = offset + 8 + length + 4;

    if (chunkEnd > buffer.length) {
      return null;
    }

    offset = chunkEnd;

    if (chunkType === 'IEND') {
      return {
        png: buffer.subarray(0, offset),
        remainder: buffer.subarray(offset)
      };
    }
  }

  return null;
}

export function slicePngStream(stream: Readable, handler: (frame: Buffer) => void) {
  let buffer = Buffer.alloc(0);

  stream.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const frame = slicePng(buffer);
      if (!frame) {
        break;
      }

      handler(frame.png);
      buffer = frame.remainder;
    }
  });
}
