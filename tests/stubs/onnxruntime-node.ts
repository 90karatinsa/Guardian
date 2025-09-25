export type TypedArray = Float32Array | Float64Array | Int32Array | BigInt64Array | number[];

export class Tensor<T extends TypedArray = Float32Array> {
  constructor(
    public readonly type: string,
    public readonly data: T,
    public readonly dims: number[]
  ) {}
}

export interface OnnxValue {
  data?: TypedArray;
  dims?: number[];
}

export interface InferenceSessionLike {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
}

function missingModelError(modelPath: string) {
  const error = new Error(
    `Load model from ${modelPath} failed: Load model ${modelPath} failed. File doesn't exist`
  ) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

export const InferenceSession = {
  async create(modelPath: string): Promise<InferenceSessionLike> {
    throw missingModelError(modelPath);
  }
};

export default {
  Tensor,
  InferenceSession
};
