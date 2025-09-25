class StubPNG {
  width: number;
  height: number;
  data: Uint8Array;

  constructor({ width, height }: { width: number; height: number }) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }

  static sync = {
    write(png: StubPNG) {
      const header = Buffer.alloc(8);
      header.writeUInt32BE(png.width, 0);
      header.writeUInt32BE(png.height, 4);
      return Buffer.concat([header, Buffer.from(png.data)]);
    },
    read(buffer: Buffer) {
      if (buffer.length < 8) {
        throw new Error('Invalid PNG buffer');
      }
      const width = buffer.readUInt32BE(0);
      const height = buffer.readUInt32BE(4);
      const data = new Uint8Array(buffer.subarray(8));
      if (data.length < width * height * 4) {
        const padded = new Uint8Array(width * height * 4);
        padded.set(data);
        return { width, height, data: padded };
      }
      return { width, height, data };
    }
  } as const;
}

export { StubPNG as PNG };
export default { PNG: StubPNG };
