// Fixture: production caller that references a symbol from a sibling source file.
// Tests copy the CONTENT pattern (not this file) into a temp dir to create a
// non-test caller.
import { targetFn } from './source';
targetFn();
