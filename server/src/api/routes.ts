import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  ActivityQuerySchema,
  CalendarMonthSchema,
  CaptureRequestSchema,
  CollectionIdSchema,
  CreateCollectionRequestSchema,
  CreateEntryRequestSchema,
  DeleteEntryRequestSchema,
  EntryQuerySchema,
  MigrateEntryRequestSchema,
  MutationIdHeaderSchema,
  PairRequestSchema,
  RestoreEntryRequestSchema,
  RevertActivityRequestSchema,
  ScheduleMonthlyRequestSchema,
  SettingsPatchSchema,
  SummaryRewriteRequestSchema,
  SummarySaveRequestSchema,
  TimelineQuerySchema,
  TokenCreateRequestSchema,
  type AgentTokenScope,
  UlidSchema,
  UpdateCollectionRequestSchema,
  UpdateEntryRequestSchema,
} from '../contracts/index.js';
import { HttpError } from './errors.js';
import {
  createDeviceAuth,
  createOriginGuard,
  createPairHandler,
  type DeviceAuthenticator,
} from './security.js';
import type { SseHub } from './sse.js';

export interface OwnerActor {
  kind: 'owner';
  deviceId: string;
}

export interface MutationContext {
  id: string;
  statusCode?: number;
}

export interface ApiJournalOperations extends DeviceAuthenticator {
  bootstrap(actor: OwnerActor): unknown | Promise<unknown>;
  timeline(query: Record<string, unknown>, actor: OwnerActor): unknown | Promise<unknown>;
  listEntries(query: Record<string, unknown>, actor: OwnerActor): unknown | Promise<unknown>;
  createEntry(
    input: Record<string, unknown>,
    actor: OwnerActor,
    mutation: MutationContext,
  ): unknown | Promise<unknown>;
  updateEntry(
    id: string,
    patch: Record<string, unknown>,
    expectedRevision: number | undefined,
    actor: OwnerActor,
    mutation: MutationContext,
  ): unknown | Promise<unknown>;
  deleteEntry(
    id: string,
    expectedRevision: number | undefined,
    actor: OwnerActor,
    mutation: MutationContext,
  ): unknown | Promise<unknown>;
  capture(
    input: Record<string, unknown>,
    actor: OwnerActor,
    mutation: MutationContext,
  ): unknown | Promise<unknown>;
  migrateEntry(
    id: string,
    input: {
      newEntryId?: string | undefined;
      target?: string | undefined;
      expectedRevision?: number | undefined;
    },
    actor: OwnerActor,
    mutation: MutationContext,
  ): unknown | Promise<unknown>;
  scheduleMonthly(
    id: string,
    input: {
      copyId?: string | undefined;
      month?: string | undefined;
      target?: string | undefined;
      expectedRevision?: number | undefined;
    },
    actor: OwnerActor,
    mutation: MutationContext,
  ): unknown | Promise<unknown>;
  restoreEntry?(
    id: string,
    expectedRevision: number | undefined,
    actor: OwnerActor,
  ): unknown | Promise<unknown>;
  listRecentlyDeleted?(actor: OwnerActor): unknown | Promise<unknown>;
  listCollections(actor: OwnerActor): unknown | Promise<unknown>;
  listTags(actor: OwnerActor): unknown | Promise<unknown>;
  createCollection(
    input: Record<string, unknown>,
    actor: OwnerActor,
    mutation: MutationContext,
  ): unknown | Promise<unknown>;
  updateCollection(
    id: string,
    input: Record<string, unknown>,
    actor: OwnerActor,
    mutation: MutationContext,
  ): unknown | Promise<unknown>;
  listActivity(
    query: { before?: string | undefined; limit: number },
    actor: OwnerActor,
  ): unknown | Promise<unknown>;
  revertActivity(id: string, actor: OwnerActor): unknown | Promise<unknown>;
  latestSummary(actor: OwnerActor, month?: string): unknown | Promise<unknown>;
  saveLatestSummary(
    summaryId: string | undefined,
    expectedRevision: number | undefined,
    actor: OwnerActor,
  ): unknown | Promise<unknown>;
  rewriteLatestSummary(
    summaryId: string | undefined,
    expectedRevision: number | undefined,
    actor: OwnerActor,
  ): unknown | Promise<unknown>;
  getSettings(actor: OwnerActor): unknown | Promise<unknown>;
  updateSettings(input: Record<string, unknown>, actor: OwnerActor): unknown | Promise<unknown>;
  listTokens(actor: OwnerActor): unknown | Promise<unknown>;
  createToken(
    label: string,
    scopes: readonly AgentTokenScope[],
    actor: OwnerActor,
  ): unknown | Promise<unknown>;
  revokeToken(id: string, actor: OwnerActor): unknown | Promise<unknown>;
}

export interface ApiRouterOptions {
  operations: ApiJournalOperations;
  sse: SseHub;
  hostAllowlist: readonly string[];
  production: boolean;
  mcpStatus: () => { activeSessions: number; recentlyActive: boolean };
}

const idSchema = UlidSchema;
const mutationIdSchema = MutationIdHeaderSchema;
const collectionIdSchema = CollectionIdSchema;

function actor(request: Request): OwnerActor {
  if (!request.device) throw new HttpError(401, 'unauthenticated', 'Pair this device first.');
  return { kind: 'owner', deviceId: request.device.deviceId };
}

function mutation(request: Request, statusCode = 200): MutationContext {
  const raw = request.get('idempotency-key') ?? request.get('x-mutation-id');
  const parsed = mutationIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(
      400,
      'mutation_id_required',
      'A valid Idempotency-Key (or X-Mutation-ID) header is required for this mutation.',
    );
  }
  return { id: parsed.data, statusCode };
}

function asyncRoute(handler: (request: Request) => unknown | Promise<unknown>, status = 200) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      const result = await handler(request);
      response.status(status).json(result);
    } catch (error) {
      next(error);
    }
  };
}

function scalarQuery(request: Request, key: string): string | undefined {
  const value = request.query[key];
  return typeof value === 'string' ? value : undefined;
}

function expectedRevisionFromIfMatch(request: Request): number | undefined {
  const value = request.get('if-match');
  if (!value) return undefined;
  const match = /^(?:W\/)?"?(\d+)"?$/.exec(value.trim());
  if (!match)
    throw new HttpError(400, 'validation_error', 'If-Match must contain an entry revision.');
  return z.coerce.number().int().positive().parse(match[1]);
}

function entryQuery(request: Request): Record<string, unknown> {
  const raw = {
    from: scalarQuery(request, 'from'),
    to: scalarQuery(request, 'to'),
    collection: scalarQuery(request, 'collection'),
    state: scalarQuery(request, 'state'),
    type: scalarQuery(request, 'type'),
    author: scalarQuery(request, 'author'),
    tag: scalarQuery(request, 'tag'),
    q: scalarQuery(request, 'q'),
    limit: scalarQuery(request, 'limit'),
    cursor: scalarQuery(request, 'cursor'),
  };
  return EntryQuerySchema.parse({
    ...raw,
    ...(raw.limit === undefined ? {} : { limit: z.coerce.number().parse(raw.limit) }),
  });
}

function timelineQuery(request: Request): Record<string, unknown> {
  const raw = {
    to: scalarQuery(request, 'to'),
    limit: scalarQuery(request, 'limit'),
    cursor: scalarQuery(request, 'cursor'),
  };
  return TimelineQuerySchema.parse({
    ...raw,
    ...(raw.limit === undefined ? {} : { limit: z.coerce.number().parse(raw.limit) }),
  });
}

function withMcpStatus(
  request: Request,
  settings: unknown,
  status: ApiRouterOptions['mcpStatus'],
): unknown {
  const mcp = status();
  return {
    settings,
    assistant: {
      endpoint: `${request.protocol}://${request.get('host') ?? 'localhost'}/mcp`,
      status: mcp.recentlyActive ? 'connected' : 'ready',
      activeSessions: mcp.activeSessions,
    },
  };
}

export function createApiRouter(options: ApiRouterOptions): Router {
  const router = Router();
  const sameOrigin = createOriginGuard({
    hostAllowlist: options.hostAllowlist,
    requireOrigin: true,
  });

  router.post(
    '/pair',
    sameOrigin,
    (request, _response, next) => {
      try {
        request.body = PairRequestSchema.parse(request.body);
        next();
      } catch (error) {
        next(error);
      }
    },
    createPairHandler({ devices: options.operations, production: options.production }),
  );

  router.use(createDeviceAuth(options.operations));
  router.use((request, response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      next();
      return;
    }
    sameOrigin(request, response, next);
  });

  router.get('/events', options.sse.handler);
  router.get(
    '/bootstrap',
    asyncRoute(async (request) => {
      // Capturing the cursor before the read makes concurrent writes replayable;
      // duplicates are harmless, while a cursor captured afterwards could miss one.
      const cursor = options.sse.cursor;
      const data = await options.operations.bootstrap(actor(request));
      return {
        ...(typeof data === 'object' && data !== null ? data : { data }),
        cursor,
      };
    }),
  );

  router.get(
    '/timeline',
    asyncRoute((request) => options.operations.timeline(timelineQuery(request), actor(request))),
  );

  router.get(
    '/entries',
    asyncRoute((request) => options.operations.listEntries(entryQuery(request), actor(request))),
  );
  router.post(
    '/entries',
    asyncRoute(
      (request) =>
        options.operations.createEntry(
          CreateEntryRequestSchema.parse(request.body),
          actor(request),
          mutation(request, 201),
        ),
      201,
    ),
  );
  router.patch(
    '/entries/:id',
    asyncRoute((request) => {
      const body = UpdateEntryRequestSchema.parse(request.body);
      return options.operations.updateEntry(
        idSchema.parse(request.params.id),
        body.patch,
        body.expectedRevision,
        actor(request),
        mutation(request),
      );
    }),
  );
  router.delete(
    '/entries/:id',
    asyncRoute((request) =>
      options.operations.deleteEntry(
        idSchema.parse(request.params.id),
        DeleteEntryRequestSchema.parse({
          expectedRevision: expectedRevisionFromIfMatch(request),
        }).expectedRevision,
        actor(request),
        mutation(request),
      ),
    ),
  );
  router.post(
    '/entries/:id/migrate',
    asyncRoute((request) => {
      const body = MigrateEntryRequestSchema.parse(request.body);
      return options.operations.migrateEntry(
        idSchema.parse(request.params.id),
        body,
        actor(request),
        mutation(request),
      );
    }),
  );
  const scheduleHandler = asyncRoute((request) => {
    const body = ScheduleMonthlyRequestSchema.parse(request.body);
    return options.operations.scheduleMonthly(
      idSchema.parse(request.params.id),
      body,
      actor(request),
      mutation(request),
    );
  });
  router.post('/entries/:id/schedule', scheduleHandler);
  router.post(
    '/entries/:id/restore',
    asyncRoute((request) => {
      if (!options.operations.restoreEntry)
        throw new HttpError(404, 'not_found', 'Restore is unavailable.');
      const { expectedRevision } = RestoreEntryRequestSchema.parse(request.body ?? {});
      return options.operations.restoreEntry(
        idSchema.parse(request.params.id),
        expectedRevision ?? expectedRevisionFromIfMatch(request),
        actor(request),
      );
    }),
  );
  router.get(
    '/recovery/deleted',
    asyncRoute((request) => {
      if (!options.operations.listRecentlyDeleted)
        throw new HttpError(404, 'not_found', 'Deleted-entry recovery is unavailable.');
      return options.operations.listRecentlyDeleted(actor(request));
    }),
  );
  router.post(
    '/capture',
    asyncRoute((request) => {
      const parsed = CaptureRequestSchema.parse(request.body);
      return options.operations.capture(parsed, actor(request), mutation(request, 201));
    }, 201),
  );

  router.get(
    '/collections',
    asyncRoute((request) => options.operations.listCollections(actor(request))),
  );
  router.get(
    '/tags',
    asyncRoute((request) => options.operations.listTags(actor(request))),
  );
  router.post(
    '/collections',
    asyncRoute(
      (request) =>
        options.operations.createCollection(
          CreateCollectionRequestSchema.parse(request.body),
          actor(request),
          mutation(request, 201),
        ),
      201,
    ),
  );
  router.patch(
    '/collections/:id',
    asyncRoute((request) =>
      options.operations.updateCollection(
        collectionIdSchema.parse(request.params.id),
        UpdateCollectionRequestSchema.parse(request.body),
        actor(request),
        mutation(request),
      ),
    ),
  );

  router.get(
    '/activity',
    asyncRoute((request) => {
      const rawLimit = scalarQuery(request, 'limit');
      const query = ActivityQuerySchema.parse({
        before: scalarQuery(request, 'before'),
        ...(rawLimit === undefined ? {} : { limit: z.coerce.number().parse(rawLimit) }),
      });
      return options.operations.listActivity(query, actor(request));
    }),
  );
  router.post(
    '/activity/:id/revert',
    asyncRoute((request) => {
      const id = idSchema.parse(request.params.id);
      const body = RevertActivityRequestSchema.parse(request.body ?? {});
      if (body.expectedActivityId !== undefined && body.expectedActivityId !== id) {
        throw new HttpError(
          409,
          'revert_conflict',
          'Activity no longer matches the requested revert.',
        );
      }
      return options.operations.revertActivity(id, actor(request));
    }),
  );

  router.get(
    '/summary/latest',
    asyncRoute((request) => {
      const rawMonth = scalarQuery(request, 'month');
      const month = rawMonth === undefined ? undefined : CalendarMonthSchema.parse(rawMonth);
      return options.operations.latestSummary(actor(request), month);
    }),
  );
  router.post(
    '/summary/latest/save',
    asyncRoute((request) => {
      const body = SummarySaveRequestSchema.parse(request.body ?? {});
      return options.operations.saveLatestSummary(
        body.summaryId,
        body.expectedRevision,
        actor(request),
      );
    }),
  );
  router.post(
    '/summary/latest/rewrite',
    asyncRoute((request) => {
      const body = SummaryRewriteRequestSchema.parse(request.body ?? {});
      return options.operations.rewriteLatestSummary(
        body.summaryId,
        body.expectedRevision,
        actor(request),
      );
    }),
  );

  router.get(
    '/settings',
    asyncRoute(async (request) =>
      withMcpStatus(
        request,
        await options.operations.getSettings(actor(request)),
        options.mcpStatus,
      ),
    ),
  );
  router.patch(
    '/settings',
    asyncRoute(async (request) =>
      withMcpStatus(
        request,
        await options.operations.updateSettings(
          SettingsPatchSchema.parse(request.body),
          actor(request),
        ),
        options.mcpStatus,
      ),
    ),
  );

  router.get(
    '/tokens',
    asyncRoute((request) => options.operations.listTokens(actor(request))),
  );
  router.post(
    '/tokens',
    asyncRoute((request) => {
      const { label, scopes } = TokenCreateRequestSchema.parse(request.body);
      return options.operations.createToken(label, scopes, actor(request));
    }, 201),
  );
  router.delete(
    '/tokens/:id',
    asyncRoute((request) =>
      options.operations.revokeToken(idSchema.parse(request.params.id), actor(request)),
    ),
  );

  return router;
}
