/** Browser-safe contract surface. Keep server-only MCP schemas out of the app bundle. */
export * from './api.js';
export * from './commands.js';
export * from './entities.js';
export * from './primitives.js';
export {
  CaptureParseError,
  CaptureSignifierSchema,
  ParsedCaptureSchema,
  parseCapture,
  safeParseCapture,
  type CaptureSignifier,
  type ParsedCapture,
  type SafeCaptureParseResult,
} from '../domain/parser.js';
