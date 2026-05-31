/**
 * Pino logger for PT Buana Megah Job Portal.
 *
 * - Emits structured JSON to stdout in production (captured by Passenger to
 *   the cPanel-managed log file per Requirement 20.1).
 * - Pretty-prints in non-production environments via `pino-pretty` transport.
 * - Provides Fastify-compatible request id generator (ulid) and request/response
 *   serializers that include only the fields required by Requirement 20.2:
 *   `req_id`, `method`, `url`, `route`, `status`, and `ip`. User-agent and the
 *   default header bag are intentionally stripped from the request serializer.
 *
 * Validates: Requirements 20.1, 20.2 (Design §18.1)
 */

import { pino, type Logger, type LoggerOptions } from 'pino';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ulid } from 'ulid';

const isProduction = process.env.NODE_ENV === 'production';

const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
};

/** Top-level pino logger instance. */
export const logger: Logger = pino(loggerOptions);

/**
 * Generate a new request id (ulid) used as `req.id` and emitted as `req_id`
 * in every access log entry.
 */
export const genReqId = (): string => ulid();

/**
 * Best-effort extraction of the matched route path. Fastify v4 exposes the
 * registered route via `request.routeOptions.url`; older request shapes fall
 * back to `routerPath`. When neither is available (e.g. 404) we return the
 * raw url so `route` is always present in logs.
 */
const resolveRoute = (request: FastifyRequest): string => {
  const routeOptions = (request as { routeOptions?: { url?: string } }).routeOptions;
  if (routeOptions?.url) {
    return routeOptions.url;
  }
  const legacyRouterPath = (request as { routerPath?: string }).routerPath;
  if (legacyRouterPath) {
    return legacyRouterPath;
  }
  return request.url;
};

/**
 * Custom pino serializers wired into Fastify so request/response logs only
 * carry the fields mandated by Requirement 20.2. Headers and user-agent from
 * pino's default request serializer are deliberately omitted.
 */
export const requestSerializers = {
  req(request: FastifyRequest): {
    id: string;
    method: string;
    url: string;
    route: string;
    ip: string;
  } {
    return {
      id: request.id,
      method: request.method,
      url: request.url,
      route: resolveRoute(request),
      ip: request.ip,
    };
  },
  res(reply: FastifyReply): { statusCode: number } {
    return {
      statusCode: reply.statusCode,
    };
  },
};
