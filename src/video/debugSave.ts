import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DIRECTORY = 'snapshots';
const FILE_NAME = 'last.png';

export function persistFrame(frame: Buffer, directory: string = DEFAULT_DIRECTORY) {
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, FILE_NAME);
  fs.writeFileSync(filePath, frame);
  return filePath;
}
