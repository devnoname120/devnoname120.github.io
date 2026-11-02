import { inspectIPA } from './inspector.js';
self.onmessage = async ({ data }) => {
  try {
    const result = await inspectIPA(data.file, progress => self.postMessage({ type: 'progress', ...progress }));
    self.postMessage({ type: 'result', result }, result.icon ? [result.icon.bytes.buffer] : []);
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'The IPA could not be inspected.' });
  }
};
