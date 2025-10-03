export type UnhandledCapture = {
  reasons: unknown[];
  restore: () => void;
};

export function captureUnhandledRejections(): UnhandledCapture {
  const reasons: unknown[] = [];
  const listener = (reason: unknown) => {
    reasons.push(reason);
  };

  process.on('unhandledRejection', listener);

  return {
    reasons,
    restore() {
      process.off('unhandledRejection', listener);
    }
  };
}
