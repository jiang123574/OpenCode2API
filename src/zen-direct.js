/**
 * Zen-direct lane.
 *
 * The stock proxy routes every request through a locally spawned `opencode serve`
 * process. That backend owns a FIXED tool registry (bash, read, edit, task, ...),
 * so a client's own tool schemas can never be handed to the model as real
 * functions: they are flattened into a `<function_calls>` text contract instead,
 * and any native tool call the model makes is refused by
 * `plugin/opencode2api-tool-lock.js` ("Tool ... is disabled by opencode2api").
 *
 * For an agent host that owns its own tool loop (DSH, Cline, Roo, ...) that is
 * the wrong shape: the host wants native `tool_calls`, executes them itself, and
 * feeds results back. This module serves that shape directly against the
 * OpenCode Zen free lane, with no OpenCode server in the path.
 *
 * What the free lane actually requires (measured 2026-10-22, see
 * docs/zh/zen-direct.md):
 *   - a canonical `ses_*` session header (12 hex inverted-ms + 14 base62)
 *   - `stream: true`
 *   - a `tools` array that contains BOTH `bash` and `read` with non-empty
 *     `parameters.properties` — "agent shaped"
 * Extra client tools are accepted untouched, which is the whole point: the
 * gate is about *shape*, not about matching the official client's list.
 *
 * Enable with OPENCODE_ZEN_DIRECT=true.
 */
import crypto from 'crypto';
import { Readable } from 'stream';
import { ProxyAgent } from 'undici';

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/v1';
const DEFAULT_PUBLIC_KEY = 'public';
const UPSTREAM_RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const FREE_MODEL_ID = /-free$/;
const FREE_MODEL_EXTRA = new Set(['big-pickle']);

/* ------------------------------------------------------------------ */
/* identifiers                                                         */
/* ------------------------------------------------------------------ */

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function base62Fixed(value, width) {
    let n = value;
    const out = new Array(width);
    for (let i = width - 1; i >= 0; i--) {
        out[i] = BASE62.charAt(Number(n % 62n));
        n /= 62n;
    }
    return out.join('');
}

/**
 * Reverse-engineered OpenCode session id: the free lane decodes the 12 hex
 * characters back into a millisecond clock (bitwise inverted, low 12 bits are a
 * per-millisecond counter that must land in [0, 63]) and rejects anything else.
 * A plain digest prefix matches the regex but fails that decode, so it 403s.
 */
export function canonicalSessionId(seed, now = Date.now()) {
    const digest = crypto.createHash('sha256').update(`ses\x00${seed}`).digest();
    const current = BigInt(now) * 0x1000n + 1n;
    const timePart = (~current & 0xffffffffffffn).toString(16).padStart(12, '0');
    const randomPart = base62Fixed(BigInt(`0x${digest.subarray(6, 16).toString('hex')}`), 14);
    return `ses_${timePart}${randomPart}`;
}

function conversationSeed(messages) {
    for (const message of Array.isArray(messages) ? messages : []) {
        if (message?.role !== 'user') continue;
        const encoded = JSON.stringify(message.content ?? null);
        if (encoded && encoded !== 'null') return encoded;
    }
    return crypto.randomBytes(8).toString('hex');
}

function disguiseHeaders(sessionId, apiKey) {
    return {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'user-agent': `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`,
        'x-opencode-client': 'cli',
        'x-opencode-session': sessionId,
        'x-opencode-session-id': sessionId,
        'x-session-affinity': sessionId,
        'X-Session-Id': sessionId,
        'x-opencode-project': 'global'
    };
}

/* ------------------------------------------------------------------ */
/* tool gate shaping                                                   */
/* ------------------------------------------------------------------ */

/**
 * The pair the free lane insists on. Schemas are the CLI's own: the gate reads
 * presence plus a non-empty `properties` map, and an empty placeholder schema is
 * refused, so these cannot be stubs with `{}`.
 */
const GATE_TOOL_DEFINITIONS = {
    bash: {
        description: 'Run a shell command in the project workspace.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The command to run.' },
                description: { type: 'string', description: 'What the command does.' }
            },
            required: ['command'],
            additionalProperties: false
        }
    },
    read: {
        description: 'Read a file from the filesystem.',
        parameters: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Absolute path of the file to read.' },
                offset: { type: 'integer', description: 'Line number to start reading from.' },
                limit: { type: 'integer', description: 'Maximum number of lines to read.' }
            },
            required: ['filePath'],
            additionalProperties: false
        }
    }
};

const GATE_NAMES = Object.keys(GATE_TOOL_DEFINITIONS);

function hasUsableProperties(parameters) {
    const properties = parameters?.properties;
    return typeof properties === 'object' && properties !== null && Object.keys(properties).length > 0;
}

function chatToolName(tool) {
    if (typeof tool !== 'object' || tool === null) return undefined;
    if (typeof tool.function?.name === 'string') return tool.function.name;
    if (typeof tool.name === 'string') return tool.name;
    return undefined;
}

/**
 * Append whichever gate tools the payload is missing. Client tools are never
 * removed or rewritten — that is what made the stock proxy give up on native
 * tool calls in the first place.
 *
 * @param {Array} tools        client tool array (chat or responses shape)
 * @param {*} toolChoice       client tool_choice
 * @param {boolean} flat       true for the Responses API's flat function shape
 * @returns {{tools: Array, toolChoice: *, injected: string[]}}
 */
export function ensureGateTools(tools, toolChoice, flat = false) {
    const input = Array.isArray(tools) ? tools : [];
    const injected = [];

    for (const name of GATE_NAMES) {
        const existing = input.find((tool) => chatToolName(tool) === name);
        if (existing && hasUsableProperties(existing.parameters ?? existing.function?.parameters)) continue;
        injected.push(name);
    }

    let kept = input;
    if (injected.length > 0) {
        // A gate name present with an empty schema is replaced, not trusted.
        kept = input.filter((tool) => {
            const name = chatToolName(tool);
            if (name === undefined || !injected.includes(name)) return true;
            return false;
        });
    }

    const appended = injected.map((name) => {
        const definition = GATE_TOOL_DEFINITIONS[name];
        if (flat) {
            return { type: 'function', name, description: definition.description, parameters: definition.parameters };
        }
        return { type: 'function', function: { name, ...definition } };
    });

    const nextTools = [...kept, ...appended];

    // Nothing was declared by the client: keep the injected pair uncallable so
    // the model cannot "use" a tool the host never offered.
    let nextChoice = toolChoice;
    if (input.length === 0) nextChoice = 'none';

    return { tools: nextTools, toolChoice: nextChoice, injected };
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export function normalizeModelId(model) {
    const raw = typeof model === 'string' && model.trim() !== '' ? model.trim() : 'big-pickle';
    return raw.replace(/^opencode\//, '');
}

/**
 * Parse OPENCODE_ZEN_PROXY: a comma-separated list of proxy URLs
 * (http://user:pass@host:port, socks5://... needs a compatible agent). Each
 * entry gets its own undici ProxyAgent; requests (and 429 retries) rotate
 * round-robin so a free-lane IP quota can be spread across egresses.
 */
export function parseProxySpec(spec) {
    if (!spec || typeof spec !== 'string') return [];
    const urls = spec.split(',').map((entry) => entry.trim()).filter(Boolean);
    return urls.map((url) => ({ url, agent: new ProxyAgent({ uri: url }) }));
}

export function isFreeLaneModel(id) {
    return FREE_MODEL_ID.test(id) || FREE_MODEL_EXTRA.has(id);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function upstreamError(status, bodyText) {
    const payload = parseJson(bodyText);
    const type = payload?.error?.type || payload?.type || 'upstream_error';
    const message = payload?.error?.message || payload?.message || bodyText.slice(0, 400) || `Upstream HTTP ${status}`;
    if (status === 403 && /freetier|free tier/i.test(`${type} ${message}`)) {
        return {
            status: 403,
            body: {
                error: {
                    type: 'free_tier_gate',
                    message:
                        'OpenCode Zen free lane refused the request shape (FreeTierError). The lane needs a streaming body whose tools array contains bash and read; '
                        + 'if this keeps happening the egress IP is throttled or the injected gate pair was stripped upstream. '
                        + `Upstream said: ${message}`,
                    upstream: payload ?? bodyText.slice(0, 800)
                }
            }
        };
    }
    if (status === 401) {
        return {
            status: 401,
            body: { error: { type, message: `${message} (free-lane models need no key; paid models do)` } }
        };
    }
    return { status, body: { error: { type, message, upstream: payload } } };
}

async function fetchUpstream(url, init, { retries = 3, debug = false, label = '', beforeAttempt = null } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const overrides = beforeAttempt ? await beforeAttempt(attempt) : {};
            const response = await fetch(url, { ...init, ...overrides });
            if (response.ok) return response;
            if (UPSTREAM_RETRY_STATUS.has(response.status) && attempt < retries) {
                const wait = 700 * 2 ** attempt;
                if (debug) console.warn(`[ZenDirect] ${label} HTTP ${response.status}; retry ${attempt + 1}/${retries} in ${wait}ms`);
                await sleep(wait);
                continue;
            }
            return response;
        } catch (error) {
            lastError = error;
            if (attempt === retries || error?.name === 'AbortError') throw error;
            const wait = 700 * 2 ** attempt;
            if (debug) console.warn(`[ZenDirect] ${label} transport error: ${error.message}; retry in ${wait}ms`);
            await sleep(wait);
        }
    }
    throw lastError ?? new Error('upstream request failed');
}

/** Fold an OpenAI-compatible SSE body into one non-streaming completion object. */
export function aggregateSse(rawBody) {
    let id = '';
    let model = '';
    let created = Math.floor(Date.now() / 1000);
    let content = '';
    let reasoning = '';
    let finishReason = null;
    let usage = null;
    const calls = [];

    for (const line of String(rawBody).split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;
        const chunk = parseJson(payload);
        if (!chunk) continue;
        if (chunk.id) id = chunk.id;
        if (chunk.model) model = chunk.model;
        if (chunk.created) created = chunk.created;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string') content += delta.content;
        if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
        for (const part of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
            const index = Number.isInteger(part.index) ? part.index : calls.length;
            calls[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (part.id) calls[index].id = part.id;
            if (part.type) calls[index].type = part.type;
            if (part.function?.name) calls[index].function.name += part.function.name;
            if (part.function?.arguments) calls[index].function.arguments += part.function.arguments;
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const toolCalls = calls.filter(Boolean).map((call, index) => ({
        id: call.id || `call_${index}`,
        type: 'function',
        function: { name: call.function.name, arguments: call.function.arguments || '{}' }
    }));

    const message = { role: 'assistant', content: toolCalls.length === 0 ? content : (content || null) };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (reasoning) message.reasoning_content = reasoning;

    return {
        id: id || `chatcmpl-${crypto.randomBytes(8).toString('hex')}`,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message, finish_reason: finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop') }],
        ...(usage ? { usage } : {})
    };
}

/* ------------------------------------------------------------------ */
/* routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Mount the direct Zen routes on an express app that has ALREADY applied its
 * auth middleware (so `req.apiKeyName` is populated by the caller).
 */
export function installZenDirectRoutes(app, options = {}) {
    const baseUrl = (options.baseUrl || process.env.OPENCODE_ZEN_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const apiKey = options.apiKey || DEFAULT_PUBLIC_KEY;
    const debug = options.debug === true;
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 120000;
    const retries = Number.isInteger(options.retries) ? options.retries : 3;

    // Egress rotation for the per-IP free-lane quota (OPENCODE_ZEN_PROXY).
    const proxies = Array.isArray(options.proxies) ? options.proxies : parseProxySpec(options.proxy);
    let proxyCursor = 0;
    const dispatcherForAttempt = () => {
        if (proxies.length === 0) return {};
        const proxy = proxies[proxyCursor++ % proxies.length];
        if (debug) console.log(`[ZenDirect] egress via ${proxy.url}`);
        return { dispatcher: proxy.agent };
    };

    let modelCache = { at: 0, data: [] };

    const log = (...args) => {
        if (debug) console.log('[ZenDirect]', ...args);
    };

    const providerLabel = (req) => `key=${req.apiKeyName || 'anonymous'}`;

    const sendError = (res, status, body) => res.status(status).json(body);

    const handleFetchFailure = (res, error, label) => {
        console.error(`[ZenDirect] ${label} failed: ${error.message}`);
        if (!res.headersSent) {
            return sendError(res, 502, {
                error: {
                    type: 'upstream_unreachable',
                    message: `Cannot reach OpenCode Zen at ${baseUrl}: ${error.message}`
                }
            });
        }
        try {
            res.end();
        } catch {
            /* client already gone */
        }
    };

    /* ---------------------------- models ---------------------------- */

    app.get('/v1/models', async (_req, res) => {
        try {
            if (Date.now() - modelCache.at < 5 * 60 * 1000 && modelCache.data.length > 0) {
                return res.json({ object: 'list', data: modelCache.data });
            }
            const response = await fetchUpstream(`${baseUrl}/models`, {
                method: 'GET',
                headers: disguiseHeaders(canonicalSessionId('models'), apiKey)
            }, { retries, debug, label: 'models', beforeAttempt: dispatcherForAttempt });
            const text = await response.text();
            if (!response.ok) {
                const mapped = upstreamError(response.status, text);
                return sendError(res, mapped.status, mapped.body);
            }
            const payload = parseJson(text) ?? {};
            const raw = Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
            const data = [];
            for (const entry of raw) {
                const id = typeof entry === 'string' ? entry : entry?.id;
                if (typeof id !== 'string' || !isFreeLaneModel(id)) continue;
                data.push({
                    id: `opencode/${id}`,
                    // Legacy clients that already store bare ids keep working:
                    // normalizeModelId() strips the prefix on the way out.
                    name: id,
                    object: 'model',
                    created: typeof entry?.created === 'number' ? entry.created : 1704067200,
                    owned_by: entry?.owned_by || 'opencode'
                });
            }
            modelCache = { at: Date.now(), data };
            return res.json({ object: 'list', data });
        } catch (error) {
            return handleFetchFailure(res, error, 'models');
        }
    });

    /* ----------------------- chat completions ----------------------- */

    app.post('/v1/chat/completions', async (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const model = normalizeModelId(body.model);
        const sessionId = canonicalSessionId(conversationSeed(body.messages));
        const wantStream = body.stream !== false;

        // The lane only answers streaming bodies, so the upstream call is always
        // streamed; a non-streaming client gets the aggregated completion.
        const shaping = ensureGateTools(body.tools, body.tool_choice, false);
        const upstreamBody = {
            ...body,
            model,
            stream: true,
            messages: Array.isArray(body.messages) ? body.messages : [],
            tools: shaping.tools
        };
        if (shaping.toolChoice === undefined || shaping.toolChoice === null) delete upstreamBody.tool_choice;
        else upstreamBody.tool_choice = shaping.toolChoice;
        if (wantStream) upstreamBody.stream_options = { include_usage: true, ...(body.stream_options || {}) };

        log(`chat model=${model} tools=${shaping.tools.length} injected=${shaping.injected.join(',') || 'none'} stream=${wantStream} ${providerLabel(req)}`);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        res.on('close', () => controller.abort());

        try {
            const response = await fetchUpstream(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: disguiseHeaders(sessionId, apiKey),
                body: JSON.stringify(upstreamBody),
                signal: controller.signal
            }, { retries, debug, label: `chat:${model}`, beforeAttempt: dispatcherForAttempt });

            if (!response.ok) {
                clearTimeout(timer);
                const text = await response.text();
                const mapped = upstreamError(response.status, text);
                return sendError(res, mapped.status, mapped.body);
            }

            if (!wantStream) {
                const text = await response.text();
                clearTimeout(timer);
                return res.json(aggregateSse(text));
            }

            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            if (typeof res.flushHeaders === 'function') res.flushHeaders();

            const stream = Readable.fromWeb(response.body);
            stream.on('error', (error) => {
                console.error(`[ZenDirect] stream error: ${error.message}`);
                try {
                    res.end();
                } catch {
                    /* ignore */
                }
            });
            res.on('finish', () => clearTimeout(timer));
            stream.pipe(res);
        } catch (error) {
            clearTimeout(timer);
            return handleFetchFailure(res, error, `chat:${model}`);
        }
    });

    /* -------------------------- responses --------------------------- */

    app.post('/v1/responses', async (req, res) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const model = normalizeModelId(body.model);
        const seed = conversationSeed(
            Array.isArray(body.input)
                ? body.input.map((item) => ({ role: item?.role || 'user', content: item?.content ?? item }))
                : [{ role: 'user', content: body.input }]
        );
        const sessionId = canonicalSessionId(seed);
        const shape = ensureGateTools(body.tools, body.tool_choice, true);
        const upstreamBody = { ...body, model, stream: true, tools: shape.tools, tool_choice: 'auto' };

        log(`responses model=${model} tools=${shape.tools.length} injected=${shape.injected.join(',') || 'none'} ${providerLabel(req)}`);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        res.on('close', () => controller.abort());

        try {
            const response = await fetchUpstream(`${baseUrl}/responses`, {
                method: 'POST',
                headers: disguiseHeaders(sessionId, apiKey),
                body: JSON.stringify(upstreamBody),
                signal: controller.signal
            }, { retries, debug, label: `responses:${model}`, beforeAttempt: dispatcherForAttempt });

            if (!response.ok) {
                clearTimeout(timer);
                const text = await response.text();
                const mapped = upstreamError(response.status, text);
                return sendError(res, mapped.status, mapped.body);
            }

            if (body.stream === false) {
                // Responses SSE carries `event:` frames; the terminal
                // `response.completed` frame holds the whole object.
                const text = await response.text();
                clearTimeout(timer);
                let completed;
                for (const line of text.split('\n')) {
                    if (!line.startsWith('data:')) continue;
                    const frame = parseJson(line.slice(5).trim());
                    if (frame?.type === 'response.completed') completed = frame.response;
                }
                return res.json(completed ?? { error: { type: 'upstream_error', message: 'stream ended without response.completed' } });
            }

            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            if (typeof res.flushHeaders === 'function') res.flushHeaders();
            const stream = Readable.fromWeb(response.body);
            res.on('finish', () => clearTimeout(timer));
            stream.on('error', () => {
                try {
                    res.end();
                } catch {
                    /* ignore */
                }
            });
            stream.pipe(res);
        } catch (error) {
            clearTimeout(timer);
            return handleFetchFailure(res, error, `responses:${model}`);
        }
    });

    return { baseUrl };
}

export default installZenDirectRoutes;
