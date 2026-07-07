// Fixture: test caller that references a symbol from a sibling source file.
// Tests copy the CONTENT pattern (not this file) into a temp dir's __tests__/
// to create a test-only caller.
import { targetFn } from './source';
void targetFn;
