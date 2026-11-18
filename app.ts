// The forge's HTTP surface: one server, four surfaces over one shared store.
//   git smart HTTP  /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack
//   REST v3         /api/v3/...
//   GraphQL v4      /api/graphql
//   MCP             /mcp
// main.ts owns the entry <-> env lifecycle; this file is the server it builds.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { store } from './store.ts';
import { sendError, sendJson } from './util.ts';
import { gitInfoRefs, gitUploadPack } from './githttp.ts';
import { gitReceivePack } from './receivepack.ts';
import { handleRest } from './rest.ts';
import { handlePulls } from './pulls.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

export interface HandlerContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** The whole request body (git packs are binary; everything else is JSON or empty). */
  body: Buffer;
}

/** The bearer token the suite presents: MAKEFUN_SHOP_TOKEN in a trial. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented.length === 0) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return expected === '' || presented === expected;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const PULLS_PATH = /^\/api\/v3\/repos\/[^/]+\/[^/]+\/pulls(\/|$)/;

async function dispatch(ctx: HandlerContext): Promise<void> {
  const { req, res, url } = ctx;
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}, no token needed.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Every other surface requires the trial's bearer token.
  if (!authorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }

  if (path === '/api/graphql') {
    await handleGraphQL(ctx);
    return;
  }
  if (path === '/mcp') {
    await handleMcp(ctx);
    return;
  }

  const git = GIT_PATH.exec(path);
  if (git !== null) {
    const owner = decodeURIComponent(git[1] as string);
    const repo = decodeURIComponent(git[2] as string);
    const tail = git[3] as string;
    if (method === 'GET' && tail === 'info/refs') {
      await gitInfoRefs(ctx, owner, repo);
      return;
    }
    if (method === 'POST' && tail === 'git-upload-pack') {
      await gitUploadPack(ctx, owner, repo);
      return;
    }
    if (method === 'POST' && tail === 'git-receive-pack') {
      await gitReceivePack(ctx, owner, repo);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (PULLS_PATH.test(path)) {
      await handlePulls(ctx);
      return;
    }
    await handleRest(ctx);
    return;
  }

  // Any unknown route answers 404 JSON, never HTML.
  sendError(res, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const body = await readBody(req);
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        await dispatch({ req, res, url, body });
      } catch {
        if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
        else res.end();
      }
    })();
  });
}
