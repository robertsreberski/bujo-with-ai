import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';
import express, { type Express, type RequestHandler } from 'express';
import pino from 'pino';
import { createStream } from 'rotating-file-stream';
import { createDomainAdapters } from './adapters.js';
import { createApiRouter, type ApiJournalOperations } from './api/routes.js';
import { HttpError, errorHandler, notFoundHandler, requireApiJsonBody } from './api/errors.js';
import { createHostGuard } from './api/security.js';
import { SseHub, type ChangeBatch } from './api/sse.js';
import {
  McpManager,
  mcpJsonBodyErrorHandler,
  mcpNotFoundHandler,
  requireMcpJsonBody,
  type McpJournalOperations,
} from './mcp/server.js';
import { projectRoot, type JournalConfig } from './config.js';
import { JournalDatabase } from './db/database.js';
import { JournalDomain } from './domain/journal.js';
import { ensurePrivateDirectory } from './private-path.js';

export interface JournalApplicationOptions {
  api: ApiJournalOperations;
  mcp: McpJournalOperations;
  version: string;
  hostAllowlist: readonly string[];
  production?: boolean;
  appDist?: string;
  viteMiddleware?: RequestHandler;
  subscribe?: (listener: (batch: ChangeBatch) => void) => () => void;
  logHttp?: (event: { method: string; path: string; status: number; durationMs: number }) => void;
  logToolCall?: (event: {
    tool: string;
    tokenId: string;
    durationMs: number;
    outcome: 'success' | 'error' | 'rate_limited';
  }) => void;
}

export interface JournalApplication {
  app: Express;
  sse: SseHub;
  mcp: McpManager;
  close(): Promise<void>;
}

export function createJournalApplication(options: JournalApplicationOptions): JournalApplication {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const appDist = resolve(options.appDist ?? join(process.cwd(), 'app', 'dist'));
  if (
    production &&
    options.viteMiddleware === undefined &&
    !existsSync(join(appDist, 'index.html'))
  ) {
    throw new Error(`Production app bundle is missing: ${join(appDist, 'index.html')}`);
  }
  const app = express();
  const sse = new SseHub();
  const mcp = new McpManager({
    operations: options.mcp,
    version: options.version,
    ...(options.logToolCall === undefined ? {} : { logToolCall: options.logToolCall }),
  });
  const unsubscribe = options.subscribe?.((batch) => {
    sse.publish(batch);
    if (batch.changes.some((change) => change.kind === 'collection.changed')) {
      mcp.notifyResourceListChanged();
    }
    for (const change of batch.changes) {
      if (
        change.kind !== 'token.changed' ||
        typeof change.payload !== 'object' ||
        change.payload === null
      ) {
        continue;
      }
      const token = change.payload as { id?: unknown; revokedAt?: unknown };
      if (typeof token.id === 'string' && typeof token.revokedAt === 'string') {
        mcp.closeSessionsForToken(token.id);
      }
    }
  });

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  if (options.logHttp) {
    app.use((request, response, next) => {
      const startedAt = performance.now();
      response.once('finish', () =>
        options.logHttp?.({
          method: request.method,
          path: request.path,
          status: response.statusCode,
          durationMs: Math.max(0, performance.now() - startedAt),
        }),
      );
      next();
    });
  }
  app.use(createHostGuard(options.hostAllowlist));
  app.use('/api', requireApiJsonBody);
  app.use('/mcp', requireMcpJsonBody);
  app.use(express.json({ limit: '1mb', strict: true }));
  app.use('/mcp', mcpJsonBodyErrorHandler);

  app.get('/healthz', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({
      status: 'ok',
      version: options.version,
      db: 'ok',
      uptime: process.uptime(),
    });
  });

  app.use(
    '/api',
    (_request, response, next) => {
      response.setHeader('Cache-Control', 'no-store');
      next();
    },
    createApiRouter({
      operations: options.api,
      sse,
      hostAllowlist: options.hostAllowlist,
      production,
      mcpStatus: () => ({
        activeSessions: mcp.activeSessionCount,
        recentlyActive: mcp.hasRecentlyActiveSession,
      }),
    }),
  );
  app.use('/api', notFoundHandler);

  app.all('/mcp', mcp.handler);
  app.use('/mcp', mcpNotFoundHandler);

  if (options.viteMiddleware) {
    app.use(options.viteMiddleware);
  } else {
    if (existsSync(appDist)) {
      // `send` decodes request paths before serving static files and throws a
      // URIError for incomplete percent escapes. A malformed SPA deep link is
      // still a navigation: serve the shell so the client router can return it
      // to a canonical safe location instead of leaking a generic JSON 500.
      app.use((request, response, next) => {
        const rawPath = request.originalUrl.split('?', 1)[0] ?? '';
        try {
          decodeURI(rawPath);
          next();
        } catch {
          if (request.method === 'GET' && request.accepts('html')) {
            response.setHeader('Cache-Control', 'no-cache');
            response.sendFile('index.html', { root: appDist });
            return;
          }
          next(new HttpError(400, 'validation_error', 'Request path is malformed.'));
        }
      });
      app.use(
        '/assets',
        express.static(join(appDist, 'assets'), {
          immutable: true,
          maxAge: '1y',
          fallthrough: false,
        }),
      );
      app.use(
        express.static(appDist, {
          index: false,
          etag: true,
          maxAge: 0,
        }),
      );
      app.get('*path', (request, response, next) => {
        if (!request.accepts('html')) {
          next();
          return;
        }
        response.setHeader('Cache-Control', 'no-cache');
        response.sendFile('index.html', { root: appDist });
      });
    }
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return {
    app,
    sse,
    mcp,
    async close() {
      unsubscribe?.();
      sse.close();
      await mcp.close();
    },
  };
}

export async function listenLoopback(
  application: JournalApplication,
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  if (host !== '127.0.0.1') {
    throw new Error('journald must bind only to 127.0.0.1; use Tailscale Serve for remote access.');
  }
  return await new Promise<Server>((resolveListen, reject) => {
    const server = application.app.listen(port, host, () => resolveListen(server));
    server.once('error', reject);
  });
}

function beginHttpServerDrain(server: Server, timeoutMs = 3_000): Promise<void> {
  return new Promise<void>((resolveClose, reject) => {
    const forceTimer = setTimeout(() => server.closeAllConnections(), timeoutMs);
    forceTimer.unref();
    server.close((error) => {
      clearTimeout(forceTimer);
      if (error) reject(error);
      else resolveClose();
    });
    server.closeIdleConnections();
  });
}

export interface JournalRuntime {
  readonly config: JournalConfig;
  readonly database: JournalDatabase;
  readonly domain: JournalDomain;
  readonly application: JournalApplication;
  start(): Promise<Server>;
  quiesce(): Promise<void>;
  close(): Promise<void>;
}

export async function createRuntime(
  config: JournalConfig,
  options: { dev?: boolean } = {},
): Promise<JournalRuntime> {
  ensurePrivateDirectory(config.logDir, 'log');
  const fileStream = createStream('journald.log', {
    path: config.logDir,
    size: '10M',
    maxFiles: 5,
    compress: 'gzip',
    mode: 0o600,
  });
  const logger = pino(
    { level: process.env.JOURNAL_LOG_LEVEL ?? 'info' },
    pino.multistream([{ stream: process.stderr }, { stream: fileStream }]),
  );
  let database: JournalDatabase | undefined;
  let domain: JournalDomain | undefined;
  let vite: { middlewares: RequestHandler; close(): Promise<void> } | undefined;

  try {
    database = new JournalDatabase({
      path: config.databasePath,
      backupDir: config.backupDir,
    });
    const activeDatabase = database;
    domain = new JournalDomain({ database: activeDatabase, config });
    const activeDomain = domain;
    const adapters = createDomainAdapters(activeDomain, config);
    if (options.dev === true) {
      const { createServer } = await import('vite');
      const server = await createServer({
        root: join(projectRoot(), 'app'),
        appType: 'spa',
        server: { middlewareMode: true },
      });
      vite = { middlewares: server.middlewares, close: () => server.close() };
    }

    const application = createJournalApplication({
      api: adapters.api,
      mcp: adapters.mcp,
      version: config.version,
      hostAllowlist: config.hostAllowlist,
      production: !config.isDevelopment,
      appDist: join(projectRoot(), 'app', 'dist'),
      ...(vite === undefined ? {} : { viteMiddleware: vite.middlewares }),
      subscribe: (listener) => activeDomain.subscribe(listener),
      logHttp: (event) => logger.info({ ...event, operation: 'http_request' }),
      logToolCall: (event) => logger.info({ ...event, operation: 'mcp_tool_call' }),
    });

    let httpServer: Server | undefined;
    let quiescing: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    const runtime: JournalRuntime = {
      config,
      database: activeDatabase,
      domain: activeDomain,
      application,
      async start() {
        if (quiescing) throw new Error('Journal runtime is quiescing.');
        if (httpServer) return httpServer;
        httpServer = await listenLoopback(application, config.port, config.bindHost);
        logger.info({
          operation: 'server_started',
          host: config.bindHost,
          port: config.port,
          version: config.version,
        });
        return httpServer;
      },
      async quiesce() {
        if (quiescing) return quiescing;
        quiescing = (async () => {
          let firstError: unknown;
          const attempt = async (operation: () => void | Promise<void>) => {
            try {
              await operation();
            } catch (error) {
              firstError ??= error;
            }
          };

          const serverDrain = httpServer ? beginHttpServerDrain(httpServer) : Promise.resolve();
          await attempt(() => application.close());
          httpServer?.closeIdleConnections();
          await attempt(() => serverDrain);
          if (firstError !== undefined) throw firstError;
        })();
        return quiescing;
      },
      async close() {
        if (closing) return closing;
        closing = (async () => {
          let firstError: unknown;
          const attempt = async (operation: () => void | Promise<void>) => {
            try {
              await operation();
            } catch (error) {
              firstError ??= error;
            }
          };

          await attempt(() => runtime.quiesce());
          await attempt(async () => vite?.close());
          await attempt(() => activeDomain.close());
          logger.info({ operation: 'server_stopped' });
          await attempt(() => new Promise<void>((resolveEnd) => fileStream.end(resolveEnd)));
          if (firstError !== undefined) throw firstError;
        })();
        return closing;
      },
    };
    return runtime;
  } catch (error) {
    const attemptCleanup = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch {
        // Preserve the original startup failure while still attempting every
        // remaining owned-resource cleanup below.
      }
    };
    await attemptCleanup(async () => vite?.close());
    if (domain !== undefined) await attemptCleanup(() => domain?.close());
    if (database !== undefined) await attemptCleanup(() => database?.close());
    await attemptCleanup(() => new Promise<void>((resolveEnd) => fileStream.end(resolveEnd)));
    throw error;
  }
}
