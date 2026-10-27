// The OpenAPI document Muse imports. Kept as data so the contract is reviewable in one place.
const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' };

export function buildOpenApi(serveHost) {
  return {
    openapi: '3.1.0',
    info: { title: 'Keelvane project conversations for Muse', version: '1.0.0' },
    servers: [{ url: `https://${serveHost}:8443` }],
    security: [{ bearer: [] }],
    paths: {
      '/muse/v1/projects': { get: { operationId: 'listKeelvaneProjects', description: 'List the projects this connector may reach.', responses: { 200: { description: 'Project codes and names' } } } },
      '/muse/v1/status': { get: { operationId: 'readKeelvaneStatus', description: 'Ready or busy. No model call.', responses: { 200: { description: 'Status' } } } },
      '/muse/v1/chats/ask': { post: {
        operationId: 'askKeelvaneProjectChat',
        description: 'Use the stable Muse ID of a dedicated project chat on every request. The first request binds this chat permanently to one project and one persistent conversation. Save request_id before sending; an exact retry reuses the turn and a changed text returns 409. Muse is one trusted identity: chat_id is a routing assertion, not security isolation. No approvals, arbitrary sessions or backend selection.',
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', additionalProperties: false, required: ['chat_id', 'request_id', 'project', 'text'],
          properties: { chat_id: { type: 'string', maxLength: 200 }, request_id: id, project: { type: 'string', description: 'Project code or name from listKeelvaneProjects.' }, text: { type: 'string', maxLength: 8000 } },
        } } } },
        responses: { 202: { description: 'Accepted once' }, 200: { description: 'Existing request' }, 409: { description: 'Busy, payload conflict or chat already bound to another project' } },
      } },
      '/muse/v1/chats/read': { get: {
        operationId: 'readKeelvaneProjectChat',
        description: 'Read exactly this chat and request_id. Status idle is completed, error is terminal, running may be polled. Never automatically resubmit an interrupted request.',
        parameters: [{ name: 'chat_id', in: 'query', required: true, schema: { type: 'string' } }, { name: 'request_id', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Request result' }, 404: { description: 'Unavailable' } },
      } },
      '/muse/v1/files': { post: {
        operationId: 'createKeelvaneNote',
        description: 'Create one new text file in the project inbox, at most 40 lines. Persist request_id first. Never replaces files. No model call.',
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', additionalProperties: false, required: ['project', 'request_id', 'filename', 'content'],
          properties: { project: { type: 'string' }, request_id: id, filename: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9._-]+\\.([mM][dD]|[tT][xX][tT])$' }, content: { type: 'string' } },
        } } } },
        responses: { 200: { description: 'Saved or replayed' }, 409: { description: 'Conflict; nothing overwritten' } },
      } },
    },
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
  };
}
